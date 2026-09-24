import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { VM } from "@earendil-works/gondolin";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAskJev, createJudge, createLedger, describeJevProblem, type Judge } from "../jev.ts";
import { decisionLine, shouldShow } from "../jev-display.ts";
import { quotaError } from "../quota.ts";
import { plainTitle } from "../worker-display.ts";
import { readJsonFile, WORKER_RULES, WORKER_STATUSES, type WorkerResult, type WorkerTask } from "../protocol.ts";
import { createSandboxVm, GUEST_MISE_DIR, GUEST_WORKSPACE, guestEnv, type Mount } from "../sandbox.ts";
import { createEgressPolicy } from "./egress.ts";
import { registerSandboxTools, type SandboxHandle } from "./sandbox-tools.ts";
import { createStuckDetector } from "./stuck.ts";
import { runVerification, shouldVerify } from "./verify.ts";
import { registerWebSearch } from "./web-search.ts";

/**
 * Loaded only into worker Pi processes (`--no-extensions -e`). Pi and this
 * extension stay on the host; every model-driven action goes through the
 * sandboxed tools.
 */
export default function worker(pi: ExtensionAPI) {
  pi.registerFlag("pi-lead-task", { type: "string", description: "PI Lead worker task file" });

  let task: WorkerTask | undefined;
  let latestContext: ExtensionContext | undefined;
  let running: Promise<SandboxHandle> | undefined;
  let seq = 0;
  /** Error of the last assistant message of the run, until Pi settles. */
  let runError: string | undefined;

  const loadTask = async () => {
    if (task) return task;
    const path = pi.getFlag("pi-lead-task");
    if (typeof path !== "string" || !path) throw new Error("PI Lead worker started without --pi-lead-task");
    task = await readJsonFile<WorkerTask>(path);
    // Continue numbering after a /reload or /new in this tab, so the Lead sees the next finish.
    try {
      const previous = JSON.parse(await readFile(task.resultPath, "utf8")) as { seq?: unknown };
      if (typeof previous.seq === "number" && Number.isInteger(previous.seq)) seq = previous.seq;
    } catch {
      // No result yet.
    }
    return task;
  };

  let judge: Judge | undefined;
  const getJudge = async () => {
    const current = await loadTask();
    judge ??= createJudge({
      ask: createAskJev(current.jev),
      config: current.jev,
      ledger: createLedger(join(getAgentDir(), "pi-lead", "jev-usage.json")),
      onProblem: (problem) => latestContext?.ui.notify(describeJevProblem(problem), "warning"),
      // In the worker's own tab only (egress checks); allowed egress is just counted.
      onDecision: (decision) => {
        if (shouldShow(decision)) latestContext?.ui.notify(decisionLine(decision), decision.outcome === "deny" ? "warning" : "info");
      },
    });
    return judge;
  };

  const startVm = async (ctx?: ExtensionContext) => {
    const current = await loadTask();
    const judge = await getJudge();
    const allow = createEgressPolicy({
      allowedHosts: current.sandbox.allowedHosts,
      task: current.task,
      judge,
      askHuman: async (question) =>
        latestContext?.hasUI ? latestContext.ui.confirm("PI Lead sandbox", question, { timeout: 120_000 }) : false,
      log: (line) => latestContext?.ui.notify(line, "info"),
    });
    ctx?.ui.setStatus("pi-lead", "Gondolin: starting");
    const mounts: Record<string, Mount> = { [GUEST_WORKSPACE]: { host: current.clonePath } };
    // Read-only: a worker must not be able to poison the toolchains of the next one.
    if (current.toolchainCache) mounts[GUEST_MISE_DIR] = { host: current.toolchainCache, readonly: true };
    // Skill folders at their host paths, so a skill's templates and scripts resolve in the guest.
    for (const dir of current.readonlyMounts ?? []) mounts[dir] = { host: dir, readonly: true };
    const vm = await createSandboxVm({ label: `pi-lead ${current.title}`, sandbox: current.sandbox, mounts, allowRequest: allow });
    const env = guestEnv(current.toolchainCache !== undefined);
    const probe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true; command -v git || true"], { env });
    const [bash, gitPath] = probe.stdout.split("\n").map((line) => line.trim());
    if (!gitPath) {
      await vm.close();
      throw new Error("the Gondolin image has no git; use PI Lead's default image or add git to yours");
    }
    // Gondolin's init writes this bundle only when its MITM CA was mounted at boot; without it every HTTPS call fails x509.
    const trust = await vm.exec(["/bin/sh", "-c", "test -r /run/gondolin/ca-certificates.crt"], { env });
    if (trust.exitCode !== 0) {
      await vm.close();
      throw new Error("the Gondolin guest booted without its MITM CA (too many mounts for the kernel command line); HTTPS would fail");
    }
    ctx?.ui.setStatus("pi-lead", `Gondolin: ${vm.id.slice(0, 8)} · ${current.branch}`);
    return { vm, shellPath: bash || "/bin/sh", env, root: current.clonePath };
  };

  const ensureVm = (ctx?: ExtensionContext) => {
    if (ctx) latestContext = ctx;
    running ??= startVm(ctx).catch((error) => {
      running = undefined;
      throw error;
    });
    return running;
  };

  const stuck = createStuckDetector({
    // Queued into the running turn; skipped when the run is already over.
    steer: (text) => {
      if (latestContext && !latestContext.isIdle()) pi.sendMessage({ customType: "pi-lead-stuck", content: text, display: true }, { deliverAs: "steer" });
    },
  });

  registerSandboxTools(
    pi,
    process.cwd(),
    ensureVm,
    (command, exitCode) => {
      if (task && task.stuckDetection !== false) stuck.record(command, exitCode);
    },
    () => stuck.progress(),
  );

  registerWebSearch(pi);

  /**
   * Commit anything left in the tree, inside the guest, so the host only ever
   * fetches from the clone.
   */
  const commitLeftovers = async (ctx?: ExtensionContext) => {
    const { vm, env } = await ensureVm(ctx);
    return vm.exec(
      ["/bin/sh", "-lc", 'git add -A && (git diff --cached --quiet || git commit -q -m "PI Lead worker: uncommitted changes") 2>&1'],
      { cwd: GUEST_WORKSPACE, env },
    );
  };

  const writeResult = async (result: WorkerResult) => {
    const current = await loadTask();
    const temporary = `${current.resultPath}.tmp`;
    await writeFile(temporary, JSON.stringify(result));
    await rename(temporary, current.resultPath);
    // A late steer must not reach a worker that already reported: a steer
    // queued now would restart its run after `finish`.
    stuck.reset();
  };

  pi.registerTool({
    name: "finish",
    label: "Finish",
    description: "Report the outcome of this delegated task to the PI Lead. Call it when done or stuck, and again after the Lead sends you more input.",
    promptSnippet: "finish: report the outcome of this delegated task to the PI Lead",
    parameters: Type.Object({
      status: StringEnum(WORKER_STATUSES, { description: "Honest outcome of the task" }),
      summary: Type.String({ description: "What changed, how it was verified, what is left" }),
      findings: Type.Optional(Type.String({ description: "Full review findings, for review tasks" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const current = await loadTask();
      const { vm, shellPath, env } = await ensureVm(ctx);
      // A failed commit (hook, identity) must not lose work: report it to the
      // model instead of finishing.
      const commit = await commitLeftovers(ctx);
      if (commit.exitCode !== 0) {
        throw new Error(`Could not commit the remaining changes; fix this, commit, then call finish again:\n${commit.stdout.slice(-2_000)}`);
      }
      // The project's own check, chosen by the trusted config and run here
      // rather than by the model: the Lead's evidence that the work holds.
      let verification: WorkerResult["verification"];
      if (shouldVerify(current, params.status)) {
        ctx?.ui.setStatus("pi-lead", `Verifying: ${current.verify}`);
        verification = await runVerification(vm, {
          command: current.verify,
          shellPath,
          env,
          ...(current.verifyTimeoutMinutes ? { timeoutMinutes: current.verifyTimeoutMinutes } : {}),
          ...(signal ? { signal } : {}),
        });
        ctx?.ui.setStatus("pi-lead", `Gondolin: ${vm.id.slice(0, 8)} · ${current.branch}`);
        // Stopped by the user: nothing is reported, `finish` can be called again.
        if (signal?.aborted) throw new Error("aborted");
      }
      const result: WorkerResult = {
        version: 1,
        id: current.id,
        seq: ++seq,
        status: params.status,
        summary: params.summary,
        ...(params.findings ? { findings: params.findings } : {}),
        ...(verification ? { verification } : {}),
      };
      if (params.status === "done") {
        // The Lead usually closes a finished worker's tab: stop the VM first
        // so no guest outlives it. Pi stays up in case the Lead disagrees and
        // relays more work; the next tool call starts a fresh VM on the clone.
        running = undefined;
        await vm.close();
      }
      await writeResult(result);
      return {
        content: [
          {
            type: "text",
            text: "Reported to the PI Lead. Stop here and wait: the Lead may send more input.",
          },
        ],
        details: result,
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    const current = await loadTask();
    // `/resume` in the worker's tab lists it by its ticket rather than its long first prompt.
    if (!pi.getSessionName()) pi.setSessionName(`${current.kind}: ${plainTitle(current.title)}`);
    void ensureVm(ctx).catch((error) => ctx.ui.notify(`PI Lead sandbox: ${error instanceof Error ? error.message : String(error)}`, "error"));
  });

  pi.on("before_agent_start", async (event) => {
    const current = await loadTask();
    // A new prompt from the Lead or the user: a new cycle for stuck detection.
    stuck.reset();
    const localLine = `Current working directory: ${process.cwd()}`;
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; branch ${current.branch})`;
    const prompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt: `${prompt}\n${WORKER_RULES}` };
  });

  // A run that ends on a provider error (exhausted quota, or anything Pi
  // stopped retrying) never reaches `finish`: report it, or the Lead would
  // wait forever on an idle tab.
  pi.on("agent_end", async (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
      | { stopReason?: string; errorMessage?: string }
      | undefined;
    runError = last?.stopReason === "error" ? last.errorMessage || "unknown provider error" : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const error = runError;
    runError = undefined;
    if (error === undefined) return;
    const quota = quotaError(error);
    const summary = `${quota ? "The model's quota is exhausted" : "The model stopped on a provider error"}: ${error.slice(0, 500)}`;
    try {
      const current = await loadTask();
      // Keep the work so far on the branch for whoever continues it, then stop
      // the VM: the worker now waits, and its next tool call starts a new one.
      // No VM means no tool ran, so there is nothing to commit.
      let uncommitted = false;
      const active = running;
      if (active) {
        const handle = await active.catch(() => undefined);
        const commit = handle ? await commitLeftovers(ctx).catch(() => undefined) : undefined;
        uncommitted = handle !== undefined && commit?.exitCode !== 0;
        if (running === active) running = undefined;
        await handle?.vm.close().catch(() => undefined);
      }
      await writeResult({
        version: 1,
        id: current.id,
        seq: ++seq,
        status: "blocked",
        summary: uncommitted ? `${summary}\nSome changes could not be committed and stay in the clone.` : summary,
        modelError: error.slice(0, 2_000),
        ...(quota ? { quota } : {}),
        ...(uncommitted ? { uncommitted } : {}),
      });
    } catch (failure) {
      // Without a result the Lead would wait on this idle tab until Pi exits.
      ctx?.ui.notify(`PI Lead could not report "${summary}": ${failure instanceof Error ? failure.message : String(failure)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    const active = running;
    running = undefined;
    if (active) await (await active.catch(() => undefined))?.vm.close();
  });
}
