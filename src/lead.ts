import { existsSync, readdirSync } from "node:fs";
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
 * Herdr's own Pi integration (working/idle/blocked badges, session identity).
 * It is trusted host code that only talks to the Herdr socket, which the
 * worker's Pi can use now that Pi runs on the host; the guest never sees it.
 */
export function findHerdrPiExtension(home = homedir()): string | undefined {
  const dir = join(home, ".pi", "agent", "extensions");
  try {
    const entry = readdirSync(dir).find((name) => /herdr/i.test(name));
    return entry ? join(dir, entry) : undefined;
  } catch {
    return undefined;
  }
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

export default function lead(pi: ExtensionAPI) {
  let delegator: ReturnType<typeof createDelegator> | undefined;
  let config: LeadConfig | undefined;

  const setup = async (ctx: ExtensionContext) => {
    config = await loadConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
    const judge = createJudge({ ask: createAskJev(config.jev), config: config.jev, ledger: createLedger() });
    delegator = createDelegator({
      config,
      judge,
      herdr: createHerdrCli(),
      workspace: gitWorkspace,
      workerCommand,
      toolchains: createToolchains({
        root: join(homedir(), ".pi", "agent", "pi-lead", "toolchains"),
        sandbox: config.sandbox,
        judge,
      }),
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
      "Hand one engineering task to a sandboxed worker (Gondolin VM, background Herdr tab, model chosen by Jev) and wait for its result. Runs the execution skills: implement, prototype, diagnosing-bugs (debug), code-review (review), research. Never for questions you can answer yourself.",
    promptSnippet: "delegate: run implement/prototype/debug/review/research work in a sandboxed background worker",
    promptGuidelines: [
      "Pass the complete ticket or request in `task`; the worker does not see this conversation.",
      "Only use kind implement for a ready ticket; shape vague ideas with the user first.",
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
          projectTrusted: ctx.isProjectTrusted(),
          ...(ctx.hasUI ? { confirm: (question: string) => ctx.ui.confirm("PI Lead sandbox", question, { timeout: 120_000 }) } : {}),
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
