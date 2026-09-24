import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult } from "../src/protocol.ts";
import worker, { COMMIT_LEFTOVERS } from "../src/worker/extension.ts";
import { runVerification, shouldVerify, VERIFY_OUTPUT_TAIL } from "../src/worker/verify.ts";

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

test("a worker result may carry a verification, which must be well formed", () => {
  const base = { version: 1, id: "t", seq: 1, status: "done", summary: "s" };
  const verification = { command: "npm test", exitCode: 1, outputTail: "1 failing", ms: 1_200 };
  assert.equal(parseWorkerResult(base, "t").verification, undefined);
  assert.deepEqual(parseWorkerResult({ ...base, verification }, "t").verification, verification);
  for (const bad of [
    "npm test",
    { ...verification, exitCode: "1" },
    { ...verification, exitCode: 1.5 },
    { ...verification, outputTail: undefined },
    { ...verification, command: 1 },
    { ...verification, ms: -1 },
    { ...verification, ms: Number.NaN },
  ]) {
    assert.throws(() => parseWorkerResult({ ...base, verification: bad }, "t"), /malformed/, JSON.stringify(bad));
  }
});

test("the worker only adds finish and web_search; stock file/shell tools come from Pi itself", async () => {
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
  assert.deepEqual(tools.sort(), ["finish", "web_search"]);

  const { systemPrompt } = await handlers.get("before_agent_start")!({
    systemPrompt: `BASE\nCurrent working directory: ${process.cwd()}`,
  });
  assert.match(systemPrompt, new RegExp(`Current working directory: ${process.cwd()}`));
  assert.match(systemPrompt, /call `finish` with an honest status/);
  assert.match(systemPrompt, /"\[PI Lead\]" come from the Lead/);
});

test("a run that ends on a provider error reports it to the Lead instead of idling", async () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  const resultPath = join(dir, "result.json");
  // No clonePath in the task: the leftover commit is skipped and the report still goes out.
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

test("finish runs the verify command only for code work that claims progress, when the project names one", () => {
  const verify = "npm test";
  for (const kind of ["implement", "prototype", "debug"] as const) {
    assert.equal(shouldVerify({ kind, verify }, "done"), true, kind);
    assert.equal(shouldVerify({ kind, verify }, "partial"), true, kind);
  }
  for (const status of ["blocked", "needs_human"] as const) assert.equal(shouldVerify({ kind: "implement", verify }, status), false, status);
  for (const kind of ["review", "research"] as const) assert.equal(shouldVerify({ kind, verify }, "done"), false, kind);
  assert.equal(shouldVerify({ kind: "implement" }, "done"), false, "no verify configured");
  assert.equal(shouldVerify({ kind: "implement", verify: "  " }, "done"), false);
});

test("the verify run executes in the given cwd on the host and keeps the exit code and an output tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-verify-"));
  await writeFile(join(dir, "marker"), "");
  let clock = 1_000;
  const result = await runVerification({
    command: `test -f marker || exit 9; node -e "process.stdout.write('y'.repeat(3000) + '\\n1 failing')"; exit 3`,
    cwd: dir,
    now: () => (clock += 500),
  });
  assert.equal(result.command.startsWith("test -f marker"), true);
  assert.equal(result.exitCode, 3, "ran in the given cwd, where marker exists");
  assert.equal(result.ms, 500);
  assert.equal(result.outputTail.length, VERIFY_OUTPUT_TAIL);
  assert.ok(result.outputTail.endsWith("\n1 failing"));
  assert.doesNotThrow(() => parseWorkerResult({ version: 1, id: "t", seq: 1, status: "done", summary: "s", verification: result }, "t"));
});

test("a verify run that errors or times out has exit code -1 and never throws", async () => {
  const failed = await runVerification({ command: "true", cwd: "/no/such/directory-pi-lead-test" });
  assert.equal(failed.exitCode, -1);
  assert.match(failed.outputTail, /could not run:/);

  const dir = await mkdtemp(join(tmpdir(), "pi-lead-verify-"));
  const timedOut = await runVerification({ command: "sleep 5", cwd: dir, timeoutMinutes: 0.0005 });
  assert.equal(timedOut.exitCode, -1);
  assert.match(timedOut.outputTail, /\[PI Lead: stopped after 0\.0005 minutes\]$/);

  const stop = new AbortController();
  const stopping = runVerification({ command: "sleep 5", cwd: dir, signal: stop.signal });
  stop.abort();
  const stoppedByUser = await stopping;
  assert.equal(stoppedByUser.exitCode, -1);
  assert.match(stoppedByUser.outputTail, /\[PI Lead: aborted\]$/);
});

test("the leftovers commit reports git add's own error on stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-not-a-repo-"));
  const { execFile } = await import("node:child_process");
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = execFile("/bin/sh", ["-c", COMMIT_LEFTOVERS], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } }, (_error, stdout) =>
      resolve({ code: child.exitCode, stdout }),
    );
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /not a git repository/);
});
