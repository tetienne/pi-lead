import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfigWithNotices } from "./config.ts";
import { createDelegator, type DelegateIO, type Delegator, type StartResult, type WorkerCommand, type WorkerInfo } from "./delegate.ts";
import { leadGuidance } from "./guidance.ts";
import { createHerdrCli } from "./herdr.ts";
import { createAskJev, createJudge, describeJevProblem, type JevDecision } from "./jev.ts";
import { isDecision, JEV_ENTRY, renderDecision } from "./jev-display.ts";
import { ROLE_ENV } from "./protocol.ts";
import { gutterBlock, renderCard } from "./report-card.ts";
import { delegateCall, delegateResult, workerCall, workerResult, type Paint } from "./tool-display.ts";
import { PROGRESS_ENTRY, renderProgress, workerCounts } from "./worker-display.ts";
import { gitWorkspace, MERGE_METHODS } from "./workspace.ts";

/** The custom message type the Lead uses to deliver worker results. */
const WORKER_REPORT_TYPE = "pi-lead-worker";
/** The custom message type that ends a `merge` run. */
const MERGE_REPORT_TYPE = "pi-lead-merge";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_DIR = join(PACKAGE_ROOT, ".agents", "skills");
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
function piInvocation(): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return [process.execPath, script];
  return /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase()) ? ["pi"] : [process.execPath];
}

/**
 * Herdr's own Pi integration (working/idle/blocked, session identity), written
 * by `herdr integration install pi`. Only checked for the startup warning:
 * workers load it with the user's other global extensions.
 */
export function findHerdrPiExtension(agentDir = getAgentDir()): string | undefined {
  const path = join(agentDir, "extensions", "herdr-agent-state.ts");
  return existsSync(path) ? path : undefined;
}

/**
 * A worker is a plain Pi like the Lead: the user's global extensions (Herdr's
 * Pi integration among them), same package and global skills and prompts,
 * running directly on the host. Its fresh worktree path has no saved trust
 * decision, so the Lead's is passed for this process only: a trusted project's
 * worker loads the project's extensions, skills, prompts and APPEND_SYSTEM.md
 * from its worktree by Pi's own discovery, an untrusted one none of them. Only
 * the worker extension and PI Lead's own skills are added (the Lead adds those
 * through `resources_discover`, inert in a worker); the Lead extension, if
 * installed globally, stays inert under `PI_LEAD_ROLE`.
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

/** What the session knows that a worker needs: the repository, the models it may use, the project's trust. */
const sessionIO = (ctx: ExtensionContext): DelegateIO => ({
  cwd: ctx.cwd,
  lead: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
  available: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
  projectTrusted: ctx.isProjectTrusted(),
});

const paint = (theme: Theme): Paint => (color, text) => theme.fg(color, text);

/** The text a tool returned to the model, which the collapsed rendering summarizes. */
const resultText = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

export default function lead(pi: ExtensionAPI) {
  // A worker or sub-agent loads the user's extensions, so this one too when
  // installed globally: it must never become a second Lead.
  if (process.env[ROLE_ENV]) return;
  let delegator: Delegator | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let closed = false;
  let hasUI = false;

  /** `delegate` calls in their start phase, which share Pi's working message. */
  let delegating = 0;

  const status = () => {
    const parts: string[] = [];
    const counts = workerCounts(delegator?.list() ?? []);
    if (counts) parts.push(hasUI && ui && counts.needsYou ? ui.theme.fg("warning", counts.text) : counts.text);
    ui?.setStatus("pi-lead", parts.length ? parts.join(" · ") : undefined);
  };

  const setup = async (ctx: ExtensionContext) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    const agentDir = getAgentDir();
    const { config, ignored } = await loadConfigWithNotices(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
    // A setting dropped by the global/project rules would otherwise vanish without a trace.
    if (ctx.hasUI) for (const notice of ignored) ctx.ui.notify(notice, "warning");
    const judge = createJudge({
      ask: createAskJev(config.jev),
      config: config.jev,
      // Otherwise a wrong key or model id silently turns every judgment into a default.
      onProblem: (message) => ui?.notify(describeJevProblem(message), "warning"),
      onDecision(decision) {
        if (closed) return;
        // A custom entry, not a message: the transcript shows it, the model never sees it.
        pi.appendEntry(JEV_ENTRY, decision);
      },
    });
    delegator = createDelegator({
      config,
      judge,
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
      // Wakes the Lead too: it tells the user what merged, and where and why the run stopped.
      onMergeReport(text) {
        if (closed) return;
        status();
        pi.sendMessage({ customType: MERGE_REPORT_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
    // Adopt this repository's workers a crashed or killed Lead left running, remove the worktrees
    // of the others; in the background, never blocking the session.
    void Promise.resolve()
      .then(() => current.reconcile(sessionIO(ctx)))
      .then(() => {
        if (!closed) status();
      })
      .catch(() => undefined);
  });

  // Workers belong to the Lead session: when it ends (quit, /new, /resume,
  // /reload), they are stopped and cleaned up before the session goes away.
  pi.on("session_shutdown", async () => {
    closed = true;
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

  // A prompt section of its own: Pi records it as a transcript delta, and other extensions keep theirs.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.pi_lead = leadGuidance(SKILLS_DIR);
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Start one engineering task in a worker (background Herdr tab, model chosen by Jev). Returns at once; the result arrives later as a message. Runs the execution skills: implement, prototype, diagnosing-bugs (debug), code-review (review), research. Never for questions you can answer yourself.",
    promptSnippet: "delegate: start implement/prototype/debug/review/research work in a background worker",
    promptGuidelines: [
      "Pass the complete ticket or request in `task`; the worker does not see this conversation.",
      "Use kind implement for a ticket, not a vague idea; shape ideas with the user first.",
      "delegate does not wait: keep talking with the user; worker results arrive as messages.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["implement", "prototype", "debug", "review", "research"] as const, { description: "Kind of work" }),
      title: Type.String({ description: "Short title, used for the tab and branch name" }),
      task: Type.String({ description: "Self-contained ticket, symptom, review scope or research question" }),
      startFrom: Type.Optional(Type.String({ description: "Local branch to start from (the branch to review)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      // Jev's difficulty call can take a few seconds: say what the wait is.
      // One shared slot: the last of parallel delegations restores Pi's default.
      if (ctx.hasUI && delegating++ === 0) ctx.ui.setWorkingMessage("Sizing up the ticket and picking a model…");
      let started: StartResult;
      try {
        started = await current.start(params, sessionIO(ctx));
      } finally {
        if (ctx.hasUI && --delegating === 0) ctx.ui.setWorkingMessage();
      }
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
              .map((w) => `- [${w.id.slice(0, 8)}] ${w.title} · ${w.kind} · ${w.state}${w.branch ? ` · ${w.branch}` : ""} · ${w.route.model}${w.pr ? ` · PR ${w.pr}` : ""}`)
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

  pi.registerTool({
    name: "merge",
    label: "Merge",
    description:
      "Merge green PRs one at a time, in the order given, only after the user said to merge them. Each PR is updated from its base (gh pr update-branch), waits for green CI on its new head (gh pr checks --watch) and is merged at that head (gh pr merge --match-head-commit) with a method the repository allows; the worker's workspace then closes. A conflict or red CI goes back to the PR's worker and stops the run. Returns at once; the outcome arrives as a message.",
    promptSnippet: "merge: merge green PRs one at a time, in ticket order, once the user said so",
    promptGuidelines: [
      "Never call merge without the user's go-ahead, for these PRs or for the whole spec.",
      "Pass the PRs in ticket order (Blocked-by first): worker ids, titles or branches, or PR numbers or URLs.",
    ],
    parameters: Type.Object({
      prs: Type.Array(Type.String(), { description: "PRs in merge order: worker id, title or branch, or PR number or URL" }),
      method: Type.Optional(StringEnum(MERGE_METHODS, { description: "Only when the user names one; otherwise the repository's first allowed method" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      const text = await current.merge(params.prs, sessionIO(ctx), params.method);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
