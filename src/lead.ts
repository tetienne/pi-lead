import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfigWithNotices, type Tier } from "./config.ts";
import { createDelegator, type Delegator, type WorkerCommand, type WorkerInfo } from "./delegate.ts";
import { leadGuidance } from "./guidance.ts";
import { createHerdrCli } from "./herdr.ts";
import { gutterBlock, renderCard, WORKER_REPORT_TYPE } from "./report-card.ts";
import { delegateCall, delegateResult, workerCall, workerResult, type Paint } from "./tool-display.ts";
import { PROGRESS_ENTRY, renderProgress, workerCounts } from "./worker-display.ts";
import { gitWorkspace } from "./workspace.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SKILLS_DIR = join(PACKAGE_ROOT, ".agents", "skills");
const WORKER_EXTENSION = join(PACKAGE_ROOT, "src", "worker", "extension.ts");

/** One line per problem that stops workers or degrades them, for a warning at session start. */
export function startupWarnings(facts: { herdr?: string; herdrPi: boolean }): string[] {
  if (!facts.herdr) return ["PI Lead: this Pi is not inside Herdr, so it cannot start workers. Start it in a Herdr pane."];
  if (!facts.herdrPi) {
    return ["PI Lead: Herdr's Pi integration is missing (worker badges and messages to workers). Run `herdr integration install pi`."];
  }
  return [];
}

/** Same resolution as Pi's subagent example: re-run the Pi that runs us. */
export function piInvocation(): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return [process.execPath, script];
  return /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase()) ? ["pi"] : [process.execPath];
}

/**
 * Herdr's own Pi integration (working/idle/blocked, session identity), written
 * by `herdr integration install pi`. It is trusted host code that only talks
 * to the Herdr socket; now that worker Pi runs on the host it works as is. The
 * worker never sees the socket.
 */
export function findHerdrPiExtension(agentDir = getAgentDir()): string | undefined {
  const path = join(agentDir, "extensions", "herdr-agent-state.ts");
  return existsSync(path) ? path : undefined;
}

/**
 * A worker is a Pi like the Lead: same global extensions, packages, skills and
 * prompts (Herdr's Pi integration among them). Pi trusts per path and the fresh
 * worktree has none saved, so the Lead's trust decision is passed on for this run.
 */
export const workerCommand: WorkerCommand = ({ taskPath, prompt, route, label, projectTrusted }) => [
  ...piInvocation(),
  projectTrusted ? "--approve" : "--no-approve",
  "-e",
  WORKER_EXTENSION,
  "--skill",
  SKILLS_DIR,
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

const WORKER_ACTIONS = ["list", "message", "stop"] as const;

const paint = (theme: Theme): Paint => (color, text) => theme.fg(color, text);

/** The text a tool returned to the model, which the collapsed rendering summarizes. */
const resultText = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

export default function lead(pi: ExtensionAPI, argv = process.argv) {
  // Workers load the user's packages, PI Lead included: a worker must not become a Lead.
  if (argv.includes("--pi-lead-task")) return;
  let delegator: Delegator | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let closed = false;
  let hasUI = false;

  const status = () => {
    const counts = workerCounts(delegator?.list() ?? []);
    const text = counts ? (hasUI && ui && counts.needsYou ? ui.theme.fg("warning", counts.text) : counts.text) : undefined;
    ui?.setStatus("pi-lead", text);
  };

  const setup = async (ctx: ExtensionContext) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    const agentDir = getAgentDir();
    const { config, ignored } = await loadConfigWithNotices(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
    // A setting dropped by the global/project rules would otherwise vanish without a trace.
    if (ctx.hasUI) for (const notice of ignored) ctx.ui.notify(notice, "warning");
    delegator = createDelegator({
      config,
      herdr: createHerdrCli(),
      workspace: gitWorkspace,
      workerCommand,
      stateRoot: join(agentDir, "pi-lead", "workers"),
      // Each result wakes the Lead, which tells the user and follows "Next".
      onOutcome(outcome) {
        // After session_shutdown this `pi` is stale; the delegator reports into the void.
        if (closed) return;
        status();
        pi.sendMessage(
          { customType: WORKER_REPORT_TYPE, content: outcome.text, display: true, details: { status: outcome.status, worker: outcome.worker, ...outcome.details } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      onProgress(text) {
        if (closed) return;
        // A transcript line, not the footer: the footer only counts.
        pi.appendEntry(PROGRESS_ENTRY, { text });
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
    const current = await setup(ctx);
    if (ctx.hasUI) {
      try {
        const herdr = createHerdrCli();
        for (const warning of startupWarnings({ ...(herdr ? { herdr: herdr.workspace } : {}), herdrPi: findHerdrPiExtension() !== undefined })) {
          ctx.ui.notify(warning, "warning");
        }
      } catch {
        // A check must never keep the session from starting or skip the reconcile below.
      }
    }
    // Remove worktrees a crashed or killed Lead left open; in the background, never blocking the session.
    void current.reconcile().catch(() => undefined);
  });

  // Workers belong to the Lead session: when it ends (quit, /new, /resume,
  // /reload), they are stopped and cleaned up before the session goes away.
  pi.on("session_shutdown", async () => {
    closed = true;
    await delegator?.shutdown();
  });

  // A card for the user; the model still reads the report's full text.
  pi.registerMessageRenderer(WORKER_REPORT_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string" ? message.content : resultText({ content: message.content });
    const card = renderCard(message.details, content, expanded, paint(theme));
    if (card === undefined) return undefined;
    const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(card.head, 0, 0));
    const said = card.said;
    if (said !== undefined) box.addChild(gutterBlock(said, paint(theme)));
    if (card.tail) box.addChild(new Text(card.tail, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ text?: unknown }>(PROGRESS_ENTRY, (entry, _options, theme) => ({
    render: (width: number) => [theme.fg("dim", renderProgress(entry.data?.text, width))],
    invalidate: () => undefined,
  }));

  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n${leadGuidance(SKILLS_DIR)}` }));

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Start one engineering task in a worker (background Herdr tab, on the tier's model). Returns at once; the result arrives later as a message. Runs the execution skills: implement, prototype, diagnosing-bugs (debug), code-review (review), research. Never for questions you can answer yourself.",
    promptSnippet: "delegate: start implement/prototype/debug/review/research work in a background worker",
    promptGuidelines: [
      "Pass the complete ticket or request in `task`; the worker does not see this conversation.",
      "Only use kind implement for a well-scoped change; shape vague ideas with the user first.",
      "delegate does not wait: keep talking with the user; worker results arrive as messages.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["implement", "prototype", "debug", "review", "research"] as const, { description: "Kind of work" }),
      title: Type.String({ description: "Short title, used for the tab and branch name" }),
      task: Type.String({ description: "Self-contained ticket, symptom, review scope or research question" }),
      startFrom: Type.Optional(Type.String({ description: "Local branch to start from (the branch to review)" })),
      tier: Type.Optional(
        StringEnum(["fast", "standard", "deep"] as const, {
          description:
            "Model tier: fast for a mechanical or single-module change, deep for cross-cutting, subtle or debugging work, standard otherwise (default standard)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      const started = await current.start(
        { kind: params.kind, title: params.title, task: params.task, ...(params.startFrom ? { startFrom: params.startFrom } : {}), ...(params.tier ? { tier: params.tier as Tier } : {}) },
        {
          cwd: ctx.cwd,
          lead: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          available: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
          projectTrusted: ctx.isProjectTrusted(),
        },
      );
      status();
      return { content: [{ type: "text", text: started.text }], details: started };
    },
    renderCall: (args, theme) => new Text(delegateCall(args, paint(theme)), 0, 0),
    renderResult: (result, { expanded, isPartial }, theme) =>
      new Text(isPartial ? theme.fg("dim", "delegating…") : delegateResult(result.details, resultText(result), expanded, paint(theme)), 0, 0),
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
      let details: { workers: WorkerInfo[] } | undefined;
      if (params.action === "list") {
        const workers = current.list();
        details = { workers };
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
      return { content: [{ type: "text", text }], details };
    },
    renderCall: (args, theme) => new Text(workerCall(args, paint(theme)), 0, 0),
    renderResult: (result, { isPartial }, theme) =>
      new Text(isPartial ? theme.fg("dim", "…") : workerResult(result.details, resultText(result), paint(theme)), 0, 0),
  });
}
