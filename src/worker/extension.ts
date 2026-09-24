import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import { isBashToolResult, isEditToolResult, isWriteToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { quotaError } from "../quota.ts";
import { plainTitle } from "../worker-display.ts";
import { readJsonFile, WORKER_RULES, WORKER_STATUSES, type WorkerResult, type WorkerTask } from "../protocol.ts";
import { createStuckDetector } from "./stuck.ts";
import { runVerification, shouldVerify } from "./verify.ts";
import { registerWebSearch } from "./web-search.ts";

/** The braces send `git add`'s stderr to stdout too, so a failure reaches the model. */
export const COMMIT_LEFTOVERS =
  '{ git add -A && (git diff --cached --quiet || git commit -q -m "PI Lead worker: uncommitted changes"); } 2>&1';

/** Run a shell command on the host, in `cwd`. Never rejects: a non-zero exit is just a result. */
function runShell(command: string, cwd: string): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", command], { cwd, encoding: "utf8", maxBuffer: 16 << 20 }, (error, stdout) => {
      const code = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
      resolve({ exitCode: error ? (typeof code === "number" ? code : 1) : 0, stdout });
    });
  });
}

/**
 * Loaded only into worker Pi processes (`--no-extensions -e`). The worker runs
 * on the host, cwd the disposable clone (`task.clonePath`): its tools are
 * Pi's own built-in ones, with no isolation from the host.
 */
export default function worker(pi: ExtensionAPI) {
  pi.registerFlag("pi-lead-task", { type: "string", description: "PI Lead worker task file" });

  let task: WorkerTask | undefined;
  let latestContext: ExtensionContext | undefined;
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

  const stuck = createStuckDetector({
    // Queued into the running turn; skipped when the run is already over.
    steer: (text) => {
      if (latestContext && !latestContext.isIdle()) pi.sendMessage({ customType: "pi-lead-stuck", content: text, display: true }, { deliverAs: "steer" });
    },
  });

  // Fed by Pi's own tool events instead of a re-registered bash tool: a
  // failing shell command counts against the streak, a file change clears it.
  pi.on("tool_result", async (event) => {
    if (isBashToolResult(event) && typeof event.input.command === "string") {
      if (task && task.stuckDetection !== false) stuck.record(event.input.command, event.isError ? 1 : 0);
    } else if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError) {
      stuck.progress();
    }
  });

  registerWebSearch(pi);

  /** Commit anything left in the tree, so the branch fetched back holds every change. */
  const commitLeftovers = async () => {
    const current = await loadTask();
    // Without it, execFile would commit in whatever repo Pi was started from.
    if (!current.clonePath) throw new Error("the task names no clone to commit in");
    return runShell(COMMIT_LEFTOVERS, current.clonePath);
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
      // A failed commit (hook, identity) must not lose work: report it to the
      // model instead of finishing.
      const commit = await commitLeftovers();
      if (commit.exitCode !== 0) {
        throw new Error(`Could not commit the remaining changes; fix this, commit, then call finish again:\n${commit.stdout.slice(-2_000)}`);
      }
      // The project's own check, chosen by the trusted config and run here
      // rather than by the model: the Lead's evidence that the work holds.
      let verification: WorkerResult["verification"];
      if (shouldVerify(current, params.status)) {
        ctx?.ui.setStatus("pi-lead", `Verifying: ${current.verify}`);
        verification = await runVerification({
          command: current.verify,
          cwd: current.clonePath,
          ...(current.verifyTimeoutMinutes ? { timeoutMinutes: current.verifyTimeoutMinutes } : {}),
          ...(signal ? { signal } : {}),
        });
        ctx?.ui.setStatus("pi-lead", `${current.kind} · ${current.branch}`);
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
    ctx.ui.setStatus("pi-lead", `${current.kind} · ${current.branch}`);
  });

  pi.on("before_agent_start", async (event) => {
    // A new prompt from the Lead or the user: a new cycle for stuck detection.
    stuck.reset();
    return { systemPrompt: `${event.systemPrompt}\n${WORKER_RULES}` };
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
      // Keep the work so far on the branch for whoever continues it.
      const commit = await commitLeftovers().catch(() => undefined);
      const uncommitted = commit !== undefined && commit.exitCode !== 0;
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
}
