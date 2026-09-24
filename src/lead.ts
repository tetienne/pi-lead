import { existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type LeadConfig } from "./config.ts";
import { createDelegator, type Delegator, type WorkerCommand } from "./delegate.ts";
import { leadGuidance } from "./guidance.ts";
import { createHerdrCli } from "./herdr.ts";
import { createWorkerImage } from "./image.ts";
import { createAskJev, createJudge, createLedger, describeJevProblem, type JevDecision, type JevUsage } from "./jev.ts";
import { isDecision, JEV_ENTRY, jevReport, jevStatus, RECENT_DECISIONS, renderDecision, shouldShow } from "./jev-display.ts";
import { registerReportGuard } from "./report-guard.ts";
import { createToolchains } from "./toolchains.ts";
import { gitWorkspace } from "./workspace.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_DIR = join(PACKAGE_ROOT, ".agents", "skills");
const WORKER_EXTENSION = join(PACKAGE_ROOT, "src", "worker", "extension.ts");

/** Same resolution as Pi's subagent example: re-run the Pi that runs us. */
function piInvocation(): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return [process.execPath, script];
  return /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase()) ? ["pi"] : [process.execPath];
}

/**
 * Herdr's own Pi integration (working/idle/blocked, session identity), written
 * by `herdr integration install pi`. It is trusted host code that only talks
 * to the Herdr socket; now that worker Pi runs on the host it works as is. The
 * guest never sees the socket.
 */
export function findHerdrPiExtension(agentDir = getAgentDir()): string | undefined {
  const path = join(agentDir, "extensions", "herdr-agent-state.ts");
  return existsSync(path) ? path : undefined;
}

/**
 * Folders of every skill Pi loaded for the Lead (settings, packages, global
 * dirs): the worker's host-side Pi loads the same ones, and its reads run in
 * the guest. Project skills are left out, workers get host copies of those.
 */
export function skillMounts(commands: SlashCommandInfo[]): string[] {
  const mounts = [SKILLS_DIR];
  for (const command of commands) {
    // A loose `.md` skill has no companion files; mounting its parent could expose all of $HOME.
    if (command.source !== "skill" || command.sourceInfo.scope === "project" || basename(command.sourceInfo.path) !== "SKILL.md") continue;
    const dir = dirname(command.sourceInfo.path);
    if (!mounts.some((mount) => dir === mount || dir.startsWith(mount + sep))) mounts.push(dir);
  }
  return mounts;
}

/**
 * A worker is a Pi like the Lead: same package and global skills and prompts,
 * plus host copies of the repository's own (see context-snapshot.ts). Code is
 * the exception: project and global extensions would run on the host, outside
 * the VM, so only the worker extension and Herdr's Pi integration load.
 */
export const workerCommand: WorkerCommand = ({ taskPath, prompt, route, label, resources }) => {
  const herdr = findHerdrPiExtension();
  return [
    ...piInvocation(),
    "--no-approve",
    "--no-extensions",
    "-e",
    WORKER_EXTENSION,
    ...(herdr ? ["-e", herdr] : []),
    "--no-builtin-tools",
    "--skill",
    SKILLS_DIR,
    ...resources.skills.flatMap((path) => ["--skill", path]),
    ...resources.prompts.flatMap((path) => ["--prompt-template", path]),
    ...(resources.appendSystem ? ["--append-system-prompt", resources.appendSystem] : []),
    "--model",
    route.model,
    "--thinking",
    route.thinking,
    "--name",
    label,
    "--pi-lead-task",
    taskPath,
    "--",
    prompt,
  ];
};

const WORKER_ACTIONS = ["list", "message", "stop"] as const;

export default function lead(pi: ExtensionAPI) {
  let delegator: Delegator | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  // One per Lead: parallel delegations share a single first-time download.
  const workerImage = createWorkerImage();
  let lastProgress = "";
  let closed = false;
  let hasUI = false;
  /** Set only when Jev is configured: the status segment and `/jev` read the shared ledger. */
  let jev: { ledger: ReturnType<typeof createLedger>; budgetUsd: number } | undefined;
  let jevUsage: JevUsage | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  /** This session's last decisions, for `/jev`. */
  const recent: JevDecision[] = [];
  registerReportGuard(pi);

  const status = () => {
    const workers = delegator?.list() ?? [];
    const running = workers.filter((w) => w.state === "queued" || w.state === "starting" || w.state === "running").length;
    const waiting = workers.filter((w) => w.state === "waiting").length;
    const parts: string[] = [];
    if (running || waiting) {
      parts.push(`workers: ${running} running${waiting ? ` · ${waiting} waiting for you` : ""}${lastProgress ? ` · ${lastProgress}` : ""}`);
    }
    if (hasUI && ui && jev && jevUsage) {
      const segment = jevStatus(jevUsage, jev.budgetUsd);
      parts.push(ui.theme.fg(segment.level, segment.text));
    }
    ui?.setStatus("pi-lead", parts.length ? parts.join(" · ") : undefined);
  };

  /** Workers charge the same ledger from their own processes, so it is re-read rather than counted here. */
  const refreshUsage = async () => {
    if (!jev || closed) return;
    jevUsage = await jev.ledger.usage().catch(() => jevUsage);
    if (!closed) status();
  };

  const setup = async (ctx: ExtensionContext) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    const agentDir = getAgentDir();
    const config: LeadConfig = await loadConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
    const ask = createAskJev(config.jev);
    const ledger = createLedger(join(agentDir, "pi-lead", "jev-usage.json"));
    jev = ask ? { ledger, budgetUsd: config.jev.dailyBudgetUsd } : undefined;
    jevUsage = undefined;
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = jev ? setInterval(() => void refreshUsage(), 30_000) : undefined;
    usageTimer?.unref();
    void refreshUsage();
    const judge = createJudge({
      ask,
      config: config.jev,
      ledger,
      // Otherwise a wrong key or model id silently turns every judgment into a default.
      onProblem: (problem) => ui?.notify(describeJevProblem(problem), "warning"),
      onDecision(decision) {
        if (closed) return;
        recent.push(decision);
        if (recent.length > RECENT_DECISIONS) recent.shift();
        // A custom entry, not a message: the transcript shows it, the model never sees it.
        if (shouldShow(decision)) pi.appendEntry(JEV_ENTRY, decision);
        void refreshUsage();
      },
    });
    delegator = createDelegator({
      config,
      judge,
      herdr: createHerdrCli(),
      workspace: gitWorkspace,
      workerCommand,
      toolchains: createToolchains({ root: join(agentDir, "pi-lead", "toolchains"), judge }),
      image: workerImage,
      // So a skill's own files (templates, scripts) resolve inside the VM too.
      readonlyMounts: skillMounts(pi.getCommands()),
      stateRoot: join(agentDir, "pi-lead", "workers"),
      // Each result wakes the Lead, which tells the user and follows "Next".
      onOutcome(outcome) {
        // After session_shutdown this `pi` is stale; the delegator reports into the void.
        if (closed) return;
        status();
        pi.sendMessage(
          { customType: "pi-lead-worker", content: outcome.text, display: true, details: { status: outcome.status, worker: outcome.worker } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      onProgress(text) {
        lastProgress = text;
        status();
      },
    });
    return delegator;
  };

  pi.on("resources_discover", (event) => {
    // In this repository the skills are already project skills.
    if (resolve(event.cwd, ".agents", "skills") === resolve(SKILLS_DIR)) return {};
    return { skillPaths: [SKILLS_DIR] };
  });

  pi.on("session_start", async (_event, ctx) => {
    closed = false;
    recent.length = 0;
    const current = await setup(ctx);
    // Close tabs a crashed or killed Lead left open; in the background, never blocking the session.
    void current.reconcile().catch(() => undefined);
  });

  // Workers belong to the Lead session: when it ends (quit, /new, /resume,
  // /reload), they are stopped and cleaned up before the session goes away.
  pi.on("session_shutdown", async () => {
    closed = true;
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = undefined;
    await delegator?.shutdown();
  });

  pi.registerEntryRenderer<JevDecision>(JEV_ENTRY, (entry, _options, theme) => {
    const decision = entry.data;
    if (!isDecision(decision)) return undefined;
    return {
      render: (width: number) => [theme.fg("dim", renderDecision(decision, width))],
      invalidate: () => undefined,
    };
  });

  pi.registerCommand("jev", {
    description: "Jev's calls and spend today, and this session's last decisions",
    handler: async (_args, ctx) => {
      if (!jev) {
        ctx.ui.notify("Jev is not configured: set its key (PI_LEAD_JEV_API_KEY by default) to let Jev judge.", "info");
        return;
      }
      jevUsage = await jev.ledger.usage();
      status();
      ctx.ui.notify(jevReport(jevUsage, jev.budgetUsd, recent), "info");
    },
  });

  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n${leadGuidance(SKILLS_DIR)}` }));

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Start one engineering task in a sandboxed worker (Gondolin VM, background Herdr tab, model chosen by Jev). Returns at once; the result arrives later as a message. Runs the execution skills: implement, prototype, diagnosing-bugs (debug), code-review (review), research. Never for questions you can answer yourself.",
    promptSnippet: "delegate: start implement/prototype/debug/review/research work in a sandboxed background worker",
    promptGuidelines: [
      "Pass the complete ticket or request in `task`; the worker does not see this conversation.",
      "Only use kind implement for a ready ticket; shape vague ideas with the user first.",
      "delegate does not wait: keep talking with the user; worker results arrive as messages.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["implement", "prototype", "debug", "review", "research"] as const, { description: "Kind of work" }),
      title: Type.String({ description: "Short title, used for the tab and branch name" }),
      task: Type.String({ description: "Self-contained ticket, symptom, review scope or research question" }),
      startFrom: Type.Optional(Type.String({ description: "Local branch to start from (the branch to review)" })),
      confirmedReady: Type.Optional(
        Type.Boolean({ description: "The user explicitly confirmed the ticket is ready although Jev doubted it" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      const started = await current.start(params, {
        cwd: ctx.cwd,
        lead: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
        available: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
        projectTrusted: ctx.isProjectTrusted(),
        ...(ctx.hasUI ? { confirm: (question: string) => ctx.ui.confirm("PI Lead sandbox", question, { timeout: 120_000 }) } : {}),
      });
      status();
      return { content: [{ type: "text", text: started.text }], details: started };
    },
  });

  pi.registerTool({
    name: "worker",
    label: "Worker",
    description:
      "List delegated workers, send a message to one (relay the user's answer to a worker waiting on a question, or steer a running one), or stop one.",
    promptSnippet: "worker: list workers, message one (relay answers), or stop one",
    parameters: Type.Object({
      action: StringEnum(WORKER_ACTIONS, { description: "list, message or stop" }),
      id: Type.Optional(Type.String({ description: "Worker id prefix, title or branch (message and stop)" })),
      message: Type.Optional(Type.String({ description: "Text for the worker (message)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      let text: string;
      if (params.action === "list") {
        const workers = current.list();
        text = workers.length
          ? workers
              .map((w) => `- [${w.id.slice(0, 8)}] ${w.title} · ${w.kind} · ${w.state}${w.branch ? ` · ${w.branch}` : ""} · ${w.route.model}`)
              .join("\n")
          : "No workers.";
      } else if (!params.id) {
        text = "Give the worker's id, title or branch.";
      } else if (params.action === "message") {
        text = params.message ? await current.message(params.id, params.message) : "Give the message to send.";
      } else {
        text = await current.stop(params.id);
      }
      status();
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
