import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import lead, { workerCommand } from "../src/lead.ts";
import { parseWorkerResult, workerPrompt, WORKER_SKILLS } from "../src/protocol.ts";

type Handler = (event: any, ctx?: any) => any;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const commands: string[] = [];
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  };
  return { api, handlers, tools, commands };
}

test("the Lead never intercepts user input: the model answers questions itself", () => {
  const pi = fakePi();
  lead(pi.api as any);
  assert.equal(pi.handlers.has("input"), false);
  assert.deepEqual(pi.commands, []);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["delegate"]);
});

test("the workflow guidance is appended to the system prompt", async () => {
  const pi = fakePi();
  lead(pi.api as any);
  const [handler] = pi.handlers.get("before_agent_start")!;
  const result = await handler!({ systemPrompt: "BASE" });
  assert.match(result.systemPrompt, /^BASE\n/);
  assert.match(result.systemPrompt, /A question.*answer\s+it directly/s);
  assert.match(result.systemPrompt, /grill-with-docs\/SKILL\.md.*to-spec\/SKILL\.md.*to-tickets\/SKILL\.md/s);
});

test("the Matt skills ship with the package and are discovered", async () => {
  const pi = fakePi();
  lead(pi.api as any);
  const [handler] = pi.handlers.get("resources_discover")!;
  const result = await handler!({ cwd: "/elsewhere", reason: "startup" });
  assert.equal(result.skillPaths.length, 1);
  for (const skills of Object.values(WORKER_SKILLS)) {
    for (const skill of skills) assert.ok(existsSync(join(result.skillPaths[0], skill, "SKILL.md")), skill);
  }
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes(".agents/skills/"));
});

test("workers load only the sandbox extension and their skills", () => {
  const argv = workerCommand({
    taskPath: "/tmp/t/task.json",
    prompt: "/skill:implement do it",
    route: { model: "anthropic/claude-sonnet-5", thinking: "high", tier: "deep" },
    skills: ["implement", "tdd"],
    label: "lead: x",
  });
  for (const flag of ["--no-approve", "--no-extensions", "--no-builtin-tools", "--no-skills"]) assert.ok(argv.includes(flag), flag);
  assert.match(argv[argv.indexOf("-e") + 1]!, /src\/worker\/extension\.ts$/);
  assert.equal(argv.filter((arg) => arg === "--skill").length, 2);
  assert.deepEqual(argv.slice(-2), ["--", "/skill:implement do it"]);
});

test("worker prompts invoke Matt skills explicitly and results are validated", () => {
  assert.match(workerPrompt("implement", "T"), /^\/skill:implement T/);
  assert.match(workerPrompt("debug", "T"), /^\/skill:diagnosing-bugs T/);
  assert.match(workerPrompt("review", "T"), /^\/skill:code-review T/);
  assert.equal(parseWorkerResult({ version: 1, id: "a", status: "done", summary: "s" }, "a").status, "done");
  assert.throws(() => parseWorkerResult({ version: 1, id: "b", status: "done", summary: "s" }, "a"));
  assert.throws(() => parseWorkerResult({ version: 1, id: "a", status: "merged", summary: "s" }, "a"));
});
