import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type LeadConfig } from "./config.ts";
import { createDelegator, type DelegateOutcome, type WorkerCommand } from "./delegate.ts";
import { leadGuidance } from "./guidance.ts";
import { createHerdrCli } from "./herdr.ts";
import { createAskJev, createJudge, createLedger } from "./jev.ts";
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

export const workerCommand: WorkerCommand = ({ taskPath, prompt, route, skills, label }) => [
  ...piInvocation(),
  // Ignore the clone's own .pi settings and packages; load only the sandbox.
  "--no-approve",
  "--no-extensions",
  "-e",
  WORKER_EXTENSION,
  "--no-builtin-tools",
  "--no-skills",
  ...skills.flatMap((skill) => ["--skill", join(SKILLS_DIR, skill)]),
  "--no-prompt-templates",
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

export default function lead(pi: ExtensionAPI) {
  let delegator: ReturnType<typeof createDelegator> | undefined;
  let config: LeadConfig | undefined;

  const setup = async (ctx: ExtensionContext) => {
    config = await loadConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
    delegator = createDelegator({
      config,
      judge: createJudge({ ask: createAskJev(config.jev), config: config.jev, ledger: createLedger() }),
      herdr: createHerdrCli(),
      workspace: gitWorkspace,
      workerCommand,
      stateRoot: join(homedir(), ".pi", "agent", "pi-lead", "workers"),
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

  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n${leadGuidance(SKILLS_DIR)}` }));

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Hand one engineering task to a sandboxed worker (Gondolin VM, background Herdr tab, model chosen by Jev) and wait for its result. Use for implementation, debugging, branch review and web research; never for questions you can answer yourself.",
    promptSnippet: "delegate: run implement/debug/review/research work in a sandboxed background worker",
    promptGuidelines: [
      "Pass the complete ticket or request in `task`; the worker does not see this conversation.",
      "Only use kind implement for a ready ticket; shape vague ideas with the user first.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["implement", "debug", "review", "research"] as const, { description: "Kind of work" }),
      title: Type.String({ description: "Short title, used for the tab and branch name" }),
      task: Type.String({ description: "Self-contained ticket, symptom, review scope or research question" }),
      startFrom: Type.Optional(Type.String({ description: "Local branch to start from (the branch to review)" })),
      confirmedReady: Type.Optional(
        Type.Boolean({ description: "The user explicitly confirmed the ticket is ready although Jev doubted it" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = delegator ?? (await setup(ctx));
      const progress = (text: string) => {
        onUpdate?.({ content: [{ type: "text", text }], details: undefined });
        ctx.ui.setStatus("pi-lead", `${current.activeCount()} worker(s) · ${text}`);
      };
      let outcome: DelegateOutcome;
      try {
        outcome = await current.run(params, {
          cwd: ctx.cwd,
          lead: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          available: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
          ...(signal ? { signal } : {}),
          progress,
        });
      } finally {
        ctx.ui.setStatus("pi-lead", current.activeCount() ? `${current.activeCount()} worker(s)` : undefined);
      }
      return { content: [{ type: "text", text: outcome.text }], details: { status: outcome.status, ...outcome.details } };
    },
  });
}
