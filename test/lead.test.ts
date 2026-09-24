import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { DELEGATED_SKILLS } from "../src/guidance.ts";
import lead, { findHerdrPiExtension, startupWarnings, workerCommand } from "../src/lead.ts";
import { parseWorkerResult, workerPrompt } from "../src/protocol.ts";

type Handler = (event: any, ctx?: any) => any;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, any>();
  const renderers = new Map<string, any>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push(name);
      commandHandlers.set(name, options);
    },
    registerEntryRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
    registerMessageRenderer(type: string, renderer: any) {
      renderers.set(`message:${type}`, renderer);
    },
  };
  return { api, handlers, tools, commands, commandHandlers, renderers };
}

test("the Lead never intercepts user input: the model answers questions itself", () => {
  const pi = fakePi();
  lead(pi.api as any);
  // Only the report guard listens to input, to see the human is back; it never rewrites or handles it.
  for (const handler of pi.handlers.get("input") ?? []) {
    const ctx = { sessionManager: { getBranch: () => [] } };
    for (const source of ["interactive", "rpc", "extension"]) {
      assert.deepEqual(handler({ type: "input", text: "how does X work?", source }, ctx), { action: "continue" });
    }
  }
  assert.ok(pi.handlers.has("tool_call"), "the report guard is registered");
  assert.deepEqual(pi.commands, ["jev"]);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["delegate", "worker", "git_read"]);
});

test("worker reports render as a card, and fall back to Pi's plain view without one", () => {
  const pi = fakePi();
  lead(pi.api as any);
  const render = pi.renderers.get("message:pi-lead-worker");
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
  const card = { kind: "debug", title: "Flaky login", model: "a/m", thinking: "high", elapsedMs: 5_000, commits: 0, next: [] };
  const content = "Worker…\n<worker-report untrusted>\nSummary:\nFound a race.\n</worker-report>";
  const lines: string[] = render({ content, details: { status: "done", card } }, { expanded: false, outputPad: 1 }, theme).render(60);
  assert.ok(lines.some((line) => line.includes("✓ debug · Flaky login: done in 5s")));
  assert.ok(lines.some((line) => line.includes("Found a race.")));
  assert.ok(lines.every((line) => line.length <= 60));
  assert.equal(render({ content: "old", details: { status: "done" } }, { expanded: false, outputPad: 1 }, theme), undefined);
});

test("Jev decisions render as dim transcript lines, and /jev explains when Jev is off", async () => {
  const pi = fakePi();
  lead(pi.api as any);
  const render = pi.renderers.get("pi-lead-jev");
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  const entry = { data: { kind: "overlap", outcome: "unsure → waits", applied: "fallback", at: 0 } };
  assert.deepEqual(render(entry, { expanded: false }, theme).render(80), ["<dim>◇ jev · overlap unsure → waits</dim>"]);
  const legacy = { data: { ...entry.data, threshold: "overlaps at p ≥ 0.5", usd: 0.00005, ms: 412 } };
  assert.deepEqual(render(legacy, { expanded: true }, theme).render(80), ["<dim>◇ jev · overlap unsure → waits</dim>"], "an entry from an older version still renders, as one line");
  assert.equal(render({ data: { junk: true } }, { expanded: false }, theme), undefined);

  const notes: string[] = [];
  await pi.commandHandlers.get("jev").handler("", { ui: { notify: (text: string) => notes.push(text) } });
  assert.match(notes[0]!, /^Jev is not configured/);
});

test("the workflow guidance is appended to the system prompt", async () => {
  const pi = fakePi();
  lead(pi.api as any);
  const [handler] = pi.handlers.get("before_agent_start")!;
  const result = await handler!({ systemPrompt: "BASE" });
  assert.match(result.systemPrompt, /^BASE\n/);
  assert.match(result.systemPrompt, /\*\*Questions\*\*.*answer them\s+directly/s);
  assert.match(result.systemPrompt, /read Matt Pocock's router `[^`]*ask-matt\/SKILL\.md`/);
  assert.match(result.systemPrompt, /`\/diagnosing-bugs` → `delegate` kind `debug`/);
  assert.match(result.systemPrompt, /- to-tickets: `[^`]*to-tickets\/SKILL\.md`/);
});

test("the Matt skills ship with the package and are discovered", async () => {
  const pi = fakePi();
  lead(pi.api as any);
  const [handler] = pi.handlers.get("resources_discover")!;
  const result = await handler!({ cwd: "/elsewhere", reason: "startup" });
  assert.equal(result.skillPaths.length, 1);
  for (const skill of ["ask-matt", ...Object.keys(DELEGATED_SKILLS)]) {
    assert.ok(existsSync(join(result.skillPaths[0], skill, "SKILL.md")), skill);
  }
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes(".agents/skills/"));
});

test("workers get the Lead's skills plus host copies of the repo's resources, and no extensions", () => {
  const base = {
    taskPath: "/tmp/t/task.json",
    prompt: "/skill:implement do it",
    route: { model: "anthropic/claude-sonnet-5", thinking: "high" as const, tier: "deep" as const },
    label: "lead: x",
  };
  const argv = workerCommand({
    ...base,
    resources: { skills: ["/tmp/t/resources/agents-skills"], prompts: ["/tmp/t/resources/prompts"], appendSystem: "/tmp/t/resources/APPEND_SYSTEM.md" },
  });
  for (const flag of ["--no-approve", "--no-extensions"]) assert.ok(argv.includes(flag), flag);
  assert.ok(!argv.includes("--no-builtin-tools"), "the worker uses Pi's stock tools");
  assert.ok(!argv.includes("--no-skills"), "global skills load like in the Lead");
  assert.match(argv[argv.indexOf("-e") + 1]!, /src\/worker\/extension\.ts$/);
  const skillArgs = argv.flatMap((arg, i) => (arg === "--skill" ? [argv[i + 1]!] : []));
  assert.equal(skillArgs.length, 2);
  assert.ok(skillArgs.includes("/tmp/t/resources/agents-skills"));
  assert.equal(argv[argv.indexOf("--prompt-template") + 1], "/tmp/t/resources/prompts");
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "/tmp/t/resources/APPEND_SYSTEM.md");
  assert.ok(!argv.some((arg) => arg.includes("/repo")), "nothing is read from the worker's worktree");
  assert.deepEqual(argv.slice(-2), ["--", "/skill:implement do it"]);

  const bare = workerCommand({ ...base, resources: { skills: [], prompts: [] } });
  assert.equal(bare.filter((arg) => arg === "--skill").length, 1);
  assert.ok(!bare.includes("--prompt-template"));
});

test("Herdr's Pi integration is found where `herdr integration install pi` writes it", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-lead-agent-dir-"));
  assert.equal(findHerdrPiExtension(home), undefined);
  await mkdir(join(home, "extensions"), { recursive: true });
  await writeFile(join(home, "extensions", "herdr-agent-state.ts"), "");
  assert.equal(findHerdrPiExtension(home), join(home, "extensions", "herdr-agent-state.ts"));
});

test("the session start warns only about what stops or degrades workers", () => {
  assert.deepEqual(startupWarnings({ herdr: "w1", herdrPi: true }), []);
  assert.match(startupWarnings({ herdrPi: true })[0]!, /not inside Herdr/);
  assert.match(startupWarnings({ herdr: "w1", herdrPi: false })[0]!, /herdr integration install pi/);
});

test("worker prompts invoke Matt skills explicitly and results are validated", () => {
  assert.match(workerPrompt("implement", "T"), /^\/skill:implement T/);
  assert.match(workerPrompt("debug", "T"), /^\/skill:diagnosing-bugs T/);
  assert.match(workerPrompt("review", "T"), /^\/skill:code-review T/);
  assert.match(workerPrompt("prototype", "T"), /^\/skill:prototype T/);
  assert.equal(parseWorkerResult({ version: 1, id: "a", seq: 1, status: "done", summary: "s" }, "a").status, "done");
  assert.throws(() => parseWorkerResult({ version: 1, id: "b", seq: 1, status: "done", summary: "s" }, "a"));
  assert.throws(() => parseWorkerResult({ version: 1, id: "a", status: "done", summary: "s" }, "a"), "seq is required");
  assert.throws(() => parseWorkerResult({ version: 1, id: "a", seq: 1, status: "merged", summary: "s" }, "a"));
});
