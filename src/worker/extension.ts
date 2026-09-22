import { rename, writeFile } from "node:fs/promises";

import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAskJev, createJudge, createLedger } from "../jev.ts";
import { readJsonFile, WORKER_RULES, WORKER_STATUSES, type WorkerResult, type WorkerTask } from "../protocol.ts";
import { createEgressPolicy } from "./egress.ts";
import { GUEST_WORKSPACE, registerSandboxTools } from "./sandbox-tools.ts";

/**
 * Loaded only into worker Pi processes (`--no-extensions -e`). Pi and this
 * extension stay on the host; every model-driven action goes through the
 * sandboxed tools.
 */
export default function worker(pi: ExtensionAPI) {
  pi.registerFlag("pi-lead-task", { type: "string", description: "PI Lead worker task file" });

  let task: WorkerTask | undefined;
  let latestContext: ExtensionContext | undefined;
  let running: Promise<{ vm: VM; shellPath: string }> | undefined;
  let finished = false;

  const loadTask = async () => {
    if (task) return task;
    const path = pi.getFlag("pi-lead-task");
    if (typeof path !== "string" || !path) throw new Error("PI Lead worker started without --pi-lead-task");
    task = await readJsonFile<WorkerTask>(path);
    return task;
  };

  const startVm = async (ctx?: ExtensionContext) => {
    const current = await loadTask();
    const judge = createJudge({ ask: createAskJev(current.jev), config: current.jev, ledger: createLedger() });
    const allow = createEgressPolicy({
      allowedHosts: current.sandbox.allowedHosts,
      task: current.task,
      judge,
      askHuman: async (question) =>
        latestContext?.hasUI ? latestContext.ui.confirm("PI Lead sandbox", question, { timeout: 120_000 }) : false,
      log: (line) => latestContext?.ui.notify(line, "info"),
    });
    const { httpHooks } = createHttpHooks({
      // Hosts are decided per request below; internal ranges stay blocked.
      allowedHosts: ["*"],
      blockInternalRanges: true,
      isRequestAllowed: (request) => allow({ method: request.method, url: request.url }),
    });
    ctx?.ui.setStatus("pi-lead", "Gondolin: starting");
    const vm = await VM.create({
      sessionLabel: `pi-lead ${current.title}`,
      ...(current.sandbox.image ? { sandbox: { imagePath: current.sandbox.image } } : {}),
      ...(current.sandbox.memory ? { memory: current.sandbox.memory } : {}),
      ...(current.sandbox.cpus ? { cpus: current.sandbox.cpus } : {}),
      httpHooks,
      allowWebSockets: false,
      vfs: { mounts: { [GUEST_WORKSPACE]: new RealFSProvider(current.clonePath) } },
    });
    const probe = await vm.exec(["/bin/sh", "-lc", "command -v bash || true; command -v git || true"]);
    const [bash, gitPath] = probe.stdout.split("\n").map((line) => line.trim());
    if (!gitPath) {
      await vm.close();
      throw new Error("the Gondolin image has no git; build one with `npm run sandbox:image`");
    }
    ctx?.ui.setStatus("pi-lead", `Gondolin: ${vm.id.slice(0, 8)} · ${current.branch}`);
    return { vm, shellPath: bash || "/bin/sh" };
  };

  const ensureVm = (ctx?: ExtensionContext) => {
    if (ctx) latestContext = ctx;
    running ??= startVm(ctx).catch((error) => {
      running = undefined;
      throw error;
    });
    return running;
  };

  registerSandboxTools(pi, process.cwd(), ensureVm);

  pi.registerTool({
    name: "finish",
    label: "Finish",
    description: "Report the outcome of this delegated task to the PI Lead. Call exactly once, at the end.",
    promptSnippet: "finish: report the outcome of this delegated task to the PI Lead",
    parameters: Type.Object({
      status: StringEnum(WORKER_STATUSES, { description: "Honest outcome of the task" }),
      summary: Type.String({ description: "What changed, how it was verified, what is left" }),
      findings: Type.Optional(Type.String({ description: "Full review findings, for review tasks" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = await loadTask();
      if (finished) throw new Error("finish was already called");
      const { vm } = await ensureVm(ctx);
      // Commit anything left in the tree, inside the guest, so the host only
      // ever fetches from the clone.
      await vm.exec(
        ["/bin/sh", "-lc", 'git add -A && (git diff --cached --quiet || git commit -q -m "PI Lead worker: uncommitted changes")'],
        { cwd: GUEST_WORKSPACE },
      );
      const result: WorkerResult = {
        version: 1,
        id: current.id,
        status: params.status,
        summary: params.summary,
        ...(params.findings ? { findings: params.findings } : {}),
      };
      if (params.status === "done") {
        // The Lead closes a finished worker's tab as soon as it reads the
        // result: stop the VM first so no guest outlives the tab.
        running = undefined;
        await vm.close();
      }
      const temporary = `${current.resultPath}.tmp`;
      await writeFile(temporary, JSON.stringify(result));
      await rename(temporary, current.resultPath);
      finished = true;
      if (params.status === "done") setTimeout(() => ctx.shutdown(), 200);
      return {
        content: [
          {
            type: "text",
            text: params.status === "done"
              ? "Reported to the PI Lead. Stop here."
              : "Reported to the PI Lead. This tab stays open; a human may continue here.",
          },
        ],
        details: result,
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    await loadTask();
    void ensureVm(ctx).catch((error) => ctx.ui.notify(`PI Lead sandbox: ${error instanceof Error ? error.message : String(error)}`, "error"));
  });

  pi.on("before_agent_start", async (event) => {
    const current = await loadTask();
    const localLine = `Current working directory: ${process.cwd()}`;
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; branch ${current.branch})`;
    const prompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt: `${prompt}\n${WORKER_RULES}` };
  });

  pi.on("session_shutdown", async () => {
    const active = running;
    running = undefined;
    if (active) await (await active.catch(() => undefined))?.vm.close();
  });
}
