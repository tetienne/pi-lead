import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type LeadConfig } from "./config.ts";
import { createDelegator, type Delegator, type WorkerCommand } from "./delegate.ts";
import { leadGuidance } from "./guidance.ts";
import { createHerdrCli } from "./herdr.ts";
import { createAskJev, createJudge, createLedger } from "./jev.ts";
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

/** A worker is a Pi like the Lead: same skills and prompts, but no host-side extensions. */
export const workerCommand: WorkerCommand = ({ taskPath, prompt, route, label, clonePath, projectTrusted }) => {
  const project = (...parts: string[]) => {
    const path = join(clonePath, ...parts);
    return existsSync(path) ? [path] : [];
  };
  const herdr = findHerdrPiExtension();
  return [
    ...piInvocation(),
    // Project-local *code* (.pi/extensions, packages) would run on the host,
    // outside the sandbox: never load it. Global extensions are excluded for
    // the same reason. Text resources are passed explicitly below.
    "--no-approve",
    "--no-extensions",
    "-e",
    WORKER_EXTENSION,
    ...(herdr ? ["-e", herdr] : []),
    "--no-builtin-tools",
    "--skill",
    SKILLS_DIR,
    ...(projectTrusted
      ? [
          ...[...project(".agents", "skills"), ...project(".pi", "skills")].flatMap((path) => ["--skill", path]),
          ...project(".pi", "prompts").flatMap((path) => ["--prompt-template", path]),
          ...project(".pi", "APPEND_SYSTEM.md").flatMap((path) => ["--append-system-prompt", path]),
        ]
      : []),
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
  let lastProgress = "";

  const status = () => {
    const workers = delegator?.list() ?? [];
    const running = workers.filter((w) => w.state === "queued" || w.state === "starting" || w.state === "running").length;
    const waiting = workers.filter((w) => w.state === "waiting").length;
    ui?.setStatus(
      "pi-lead",
      running || waiting
        ? `workers: ${running} running${waiting ? ` · ${waiting} waiting for you` : ""}${lastProgress ? ` · ${lastProgress}` : ""}`
        : undefined,
    );
  };

  const setup = async (ctx: ExtensionContext) => {
    ui = ctx.ui;
    const agentDir = getAgentDir();
    const config: LeadConfig = await loadConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
    const judge = createJudge({
      ask: createAskJev(config.jev),
      config: config.jev,
      ledger: createLedger(join(agentDir, "pi-lead", "jev-usage.json")),
    });
    delegator = createDelegator({
      config,
      judge,
      herdr: createHerdrCli(),
      workspace: gitWorkspace,
      workerCommand,
      toolchains: createToolchains({ root: join(agentDir, "pi-lead", "toolchains"), sandbox: config.sandbox, judge }),
      stateRoot: join(agentDir, "pi-lead", "workers"),
      // Each result wakes the Lead, which tells the user and follows "Next".
      onOutcome(outcome) {
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
    await setup(ctx);
  });

  pi.on("session_shutdown", async () => {
    delegator?.shutdown();
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
