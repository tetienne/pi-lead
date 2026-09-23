import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult } from "../src/protocol.ts";
import worker from "../src/worker/extension.ts";

test("the worker replaces every file/shell tool with a sandboxed one and adds finish", async () => {
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
  assert.deepEqual(tools.sort(), ["bash", "edit", "find", "finish", "grep", "ls", "read", "write"]);
  assert.ok(handlers.has("user_bash"), "! shell commands are sandboxed too");

  const { systemPrompt } = await handlers.get("before_agent_start")!({
    systemPrompt: `BASE\nCurrent working directory: ${process.cwd()}`,
  });
  assert.match(systemPrompt, /Current working directory: \/workspace \(Gondolin VM; branch pi-lead\/x-1\)/);
  assert.match(systemPrompt, /call `finish` with an honest status/);
  assert.match(systemPrompt, /"\[PI Lead\]" come from the Lead/);
});

test("a run that ends on a provider error reports it to the Lead instead of idling", async () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
  const taskPath = join(dir, "task.json");
  const resultPath = join(dir, "result.json");
  // No sandbox config: the VM cannot start, so the leftover commit is skipped and the report still goes out.
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
