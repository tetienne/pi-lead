import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult } from "../src/protocol.ts";
import worker from "../src/worker/extension.ts";
import { registerSandboxTools } from "../src/worker/sandbox-tools.ts";
import { runVerification, shouldVerify, VERIFY_OUTPUT_TAIL } from "../src/worker/verify.ts";

test("the host-side bash wrapper reports each command's exit code, -1 when it did not complete", async () => {
  const vm: any = {
    exec: (argv: string[]) => {
      const command = argv[2]!;
      const done = command.includes("hang")
        ? Promise.reject(new Error("vm gone"))
        : Promise.resolve({ exitCode: command.includes("fail") ? 1 : 0 });
      return Object.assign(done, { output: async function* () { yield { data: Buffer.from("out\n") }; } });
    },
  };
  const tools = new Map<string, any>();
  const seen: Array<[string, number]> = [];
  registerSandboxTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => undefined } as any,
    "/host/clone",
    async () => ({ vm, shellPath: "/bin/sh", env: {}, root: "/host/clone" }),
    (command, exitCode) => void seen.push([command, exitCode]),
  );
  const bash = tools.get("bash");
  await bash.execute("1", { command: "npm test" }, undefined, undefined, {});
  await assert.rejects(bash.execute("2", { command: "npm test -- fail" }, undefined, undefined, {}));
  await assert.rejects(bash.execute("3", { command: "npm test -- hang" }, undefined, undefined, {}));
  assert.deepEqual(seen, [["npm test", 0], ["npm test -- fail", 1], ["npm test -- hang", -1]]);
});

test("a successful write or edit reports a file change; a failed one does not", async () => {
  const files = new Map<string, string>([["/workspace/a.ts", "const a = 1;\n"]]);
  const vm: any = {
    fs: {
      readFile: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return Buffer.from(files.get(path)!);
      },
      writeFile: async (path: string, content: string) => void files.set(path, content),
      mkdir: async () => undefined,
      access: async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
      },
    },
  };
  const tools = new Map<string, any>();
  let changes = 0;
  registerSandboxTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => undefined } as any,
    "/host/clone",
    async () => ({ vm, shellPath: "/bin/sh", env: {}, root: "/host/clone" }),
    undefined,
    () => void changes++,
  );
  await tools.get("write").execute("1", { path: "b.ts", content: "b\n" }, undefined, undefined, {});
  assert.equal(changes, 1);
  await tools.get("edit").execute("2", { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] }, undefined, undefined, {});
  assert.equal(changes, 2);
  assert.equal(files.get("/workspace/a.ts"), "const a = 2;\n");
  await assert.rejects(tools.get("edit").execute("3", { path: "a.ts", edits: [{ oldText: "missing", newText: "x" }] }, undefined, undefined, {}));
  assert.equal(changes, 2);
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

test("the verify run uses the bash tool's shell and env at /workspace and keeps the exit code and an output tail", async () => {
  const calls: Array<{ argv: string[]; options: any }> = [];
  const vm: any = {
    exec: (argv: string[], options: any) => {
      calls.push({ argv, options });
      return Object.assign(Promise.resolve({ exitCode: 3 }), {
        output: async function* () {
          yield { data: Buffer.from("y".repeat(3_000)) };
          yield { data: Buffer.from("\n1 failing") };
        },
      });
    },
  };
  let clock = 1_000;
  const result = await runVerification(vm, { command: "npm test", shellPath: "/bin/bash", env: { CI: "1" }, now: () => (clock += 500) });
  assert.deepEqual(calls[0]!.argv, ["/bin/bash", "-lc", "npm test"]);
  assert.equal(calls[0]!.options.cwd, "/workspace");
  assert.deepEqual(calls[0]!.options.env, { CI: "1" });
  assert.equal(result.command, "npm test");
  assert.equal(result.exitCode, 3);
  assert.equal(result.ms, 500);
  assert.equal(result.outputTail.length, VERIFY_OUTPUT_TAIL);
  assert.ok(result.outputTail.endsWith("\n1 failing"));
  assert.doesNotThrow(() => parseWorkerResult({ version: 1, id: "t", seq: 1, status: "done", summary: "s", verification: result }, "t"));
});

test("a verify run that errors or times out has exit code -1 and never throws", async () => {
  const failing: any = { exec: () => Object.assign(Promise.reject(new Error("vm gone")), { output: async function* () {} }) };
  const failed = await runVerification(failing, { command: "npm test", shellPath: "/bin/sh", env: {} });
  assert.equal(failed.exitCode, -1);
  assert.match(failed.outputTail, /could not run: vm gone/);

  let aborted = false;
  const hanging: any = {
    exec: (_argv: string[], options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", () => (aborted = true));
      return Object.assign(new Promise(() => undefined), { output: async function* () { yield { data: Buffer.from("running\n") }; } });
    },
  };
  const timedOut = await runVerification(hanging, { command: "npm test", shellPath: "/bin/sh", env: {}, timeoutMinutes: 0.0005 });
  assert.equal(timedOut.exitCode, -1);
  assert.ok(aborted, "the command is aborted");
  assert.match(timedOut.outputTail, /^running\n\n\[PI Lead: stopped after 0\.0005 minutes\]$/);
});
