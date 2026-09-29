import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult, subAgentRecipe } from "../src/protocol.ts";
import worker, { commitLeftoversCommand } from "../src/worker/extension.ts";

/** A worker's `tool_result` event, as narrowed by `isBashToolResult`/`isWriteToolResult`. */
const toolResult = (toolName: string, input: Record<string, unknown>, isError: boolean) => ({
  type: "tool_result",
  toolCallId: "1",
  toolName,
  input,
  isError,
  content: [],
});

test("stuck detection is fed by Pi's own tool_result event for bash, and cleared by a file change", async () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", kind: "implement", branch: "pi-lead/x-1", title: "x" }));
  const messages: any[] = [];
  worker({
    registerFlag: () => undefined,
    getFlag: () => taskPath,
    registerTool: () => undefined,
    getSessionName: () => undefined,
    setSessionName: () => undefined,
    sendMessage: (message: unknown) => messages.push(message),
    on: (event: string, handler: any) => handlers.set(event, handler),
  } as any);
  const ctx = { isIdle: () => false, ui: { setStatus: () => undefined } };
  await handlers.get("session_start")!({}, ctx);

  await handlers.get("tool_result")!(toolResult("bash", { command: "npm test" }, true), ctx);
  await handlers.get("tool_result")!(toolResult("bash", { command: "npm test" }, true), ctx);
  await handlers.get("tool_result")!(toolResult("bash", { command: "npm test" }, true), ctx);
  assert.equal(messages.length, 1, "steered after 3 identical failures");
  assert.match(messages[0].content, /npm test.*3 times/);

  messages.length = 0;
  await handlers.get("tool_result")!(toolResult("write", {}, false), ctx);
  await handlers.get("tool_result")!(toolResult("bash", { command: "npm test" }, true), ctx);
  await handlers.get("tool_result")!(toolResult("bash", { command: "npm test" }, true), ctx);
  assert.equal(messages.length, 0, "a file change resets the streak");
});

test("the worker only adds finish; stock file/shell tools and web tools come from Pi and the user's extensions", async () => {
  const tools: string[] = [];
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const flags = new Map<string, unknown>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", branch: "pi-lead/x-1", title: "x" }));
  worker({
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: () => taskPath,
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    on: (event: string, handler: any) => handlers.set(event, handler),
  } as any);

  assert.ok(flags.has("pi-lead-task"));
  assert.deepEqual(tools, ["finish"]);

  const sections: Record<string, string> = { cwd: process.cwd() };
  assert.equal(await handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }), undefined, "the prompt is never replaced wholesale");
  assert.equal(sections.cwd, process.cwd());
  const rules = sections.pi_lead_worker!;
  assert.match(rules, /call `finish` with an honest status/);
  assert.match(rules, /"\[PI Lead\]" come from the Lead/);
  assert.ok(rules.includes(subAgentRecipe()), "workers start sub-agents the same way as the Lead");
});

test("a run that ends on a provider error reports it to the Lead instead of idling", async () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  const resultPath = join(dir, "result.json");
  // No worktreePath in the task: the leftover commit is skipped and the report still goes out.
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", branch: "pi-lead/x-1", title: "x", resultPath }));
  worker({
    registerFlag: () => undefined,
    getFlag: () => taskPath,
    registerTool: () => undefined,
    on: (event: string, handler: any) => handlers.set(event, handler),
  } as any);
  const settle = async (messages: unknown[]) => {
    await handlers.get("agent_end")!({ type: "agent_end", messages });
    await handlers.get("agent_settled")!({ type: "agent_settled" });
  };

  await settle([{ role: "assistant", stopReason: "stop" }]);
  await assert.rejects(readFile(resultPath, "utf8"), "a clean run writes nothing");

  const limit = "You have hit your ChatGPT usage limit (pro plan). Try again in ~12 min.";
  await settle([{ role: "user" }, { role: "assistant", stopReason: "error", errorMessage: limit }]);
  const result = parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t");
  assert.equal(result.seq, 1);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.quota, { message: limit, retryAfterMinutes: 12 });
  assert.match(result.summary, /quota is exhausted/);

  // A failed attempt that Pi retried successfully before settling reports nothing.
  await handlers.get("agent_end")!({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 overloaded" }] });
  await settle([{ role: "assistant", stopReason: "toolUse" }]);
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").seq, 1);

  await settle([{ role: "assistant", stopReason: "error", errorMessage: "401 unauthorized" }]);
  const second = parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t");
  assert.equal(second.seq, 2);
  assert.equal(second.quota, undefined);
  assert.equal(second.modelError, "401 unauthorized");
});

test("finish done needs no allowed-files list, reports the findings and runs no verify command", async () => {
  const { execFile } = await import("node:child_process");
  const run = (args: string[], cwd: string) => new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve())));
  const worktree = await mkdtemp(join(tmpdir(), "pi-lead-worker-git-"));
  await run(["init", "-q"], worktree);
  await run(["config", "user.email", "worker@test"], worktree);
  await run(["config", "user.name", "Worker"], worktree);
  await writeFile(join(worktree, "a.txt"), "x");

  const stateDir = await mkdtemp(join(tmpdir(), "pi-lead-worker-state-"));
  const taskPath = join(stateDir, "task.json");
  const resultPath = join(stateDir, "result.json");
  // A task written by an older Lead may still name a verify command: it is not run.
  const task = { version: 1, id: "t", kind: "implement", branch: "pi-lead/x-1", title: "x", resultPath, worktreePath: worktree, verify: "touch verify-ran" };
  await writeFile(taskPath, JSON.stringify(task));
  const tools = new Map<string, any>();
  worker({
    registerFlag: () => undefined,
    getFlag: () => taskPath,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => undefined,
  } as any);
  await tools.get("finish")!.execute(
    "1",
    { status: "done", summary: "built it", findings: "notes" },
    undefined,
    undefined,
    { ui: { setStatus: () => undefined } },
  );
  const result = parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t");
  assert.equal(result.status, "done");
  assert.equal(result.findings, "notes");
  assert.equal((result as { verification?: unknown }).verification, undefined);
  await assert.rejects(readFile(join(worktree, "verify-ran"), "utf8"), "no verify command ran in the worktree");
});

test("finish with a non-done status commits leftovers despite a failing pre-commit hook; done still runs it", async () => {
  const { execFile } = await import("node:child_process");
  const { chmod, mkdir } = await import("node:fs/promises");
  const run = (args: string[], cwd: string) => new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve())));
  const worktree = await mkdtemp(join(tmpdir(), "pi-lead-worker-git-"));
  await run(["init", "-q"], worktree);
  await run(["config", "user.email", "worker@test"], worktree);
  await run(["config", "user.name", "Worker"], worktree);
  await mkdir(join(worktree, ".git", "hooks"), { recursive: true });
  const hookPath = join(worktree, ".git", "hooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
  await chmod(hookPath, 0o755);

  const stateDir = await mkdtemp(join(tmpdir(), "pi-lead-worker-state-"));
  const taskPath = join(stateDir, "task.json");
  const resultPath = join(stateDir, "result.json");
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", kind: "implement", branch: "pi-lead/x-1", title: "x", resultPath, worktreePath: worktree }));
  const tools = new Map<string, any>();
  worker({
    registerFlag: () => undefined,
    getFlag: () => taskPath,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => undefined,
  } as any);

  await writeFile(join(worktree, "a.txt"), "partial work");
  await tools.get("finish")!.execute("1", { status: "partial", summary: "half done" }, undefined, undefined, { ui: { setStatus: () => undefined } });
  const partial = parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t");
  assert.equal(partial.status, "partial", "the --no-verify commit went through despite the failing hook");

  await writeFile(join(worktree, "b.txt"), "more work");
  await assert.rejects(
    () => tools.get("finish")!.execute("2", { status: "done", summary: "all done" }, undefined, undefined, { ui: { setStatus: () => undefined } }),
    /Could not commit the remaining changes/,
    "a done finish still runs the hook, which blocks it",
  );
});

test("the worker extension never blocks write or edit", async () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", kind: "implement", branch: "pi-lead/x-1", title: "x", worktreePath: dir }));
  worker({
    registerFlag: () => undefined,
    getFlag: () => taskPath,
    registerTool: () => undefined,
    on: (event: string, handler: any) => handlers.set(event, handler),
  } as any);
  assert.equal(handlers.get("tool_call"), undefined, "no tool_call guard is registered");
});

test("the leftovers commit reports git add's own error on stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-not-a-repo-"));
  const { execFile } = await import("node:child_process");
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = execFile("/bin/sh", ["-c", commitLeftoversCommand(true)], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } }, (_error, stdout) =>
      resolve({ code: child.exitCode, stdout }),
    );
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /not a git repository/);
});
