import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult } from "../src/protocol.ts";
import worker, { unverifiedDone } from "../src/worker/extension.ts";
import { isTestCommand, OUTPUT_TAIL, registerSandboxTools } from "../src/worker/sandbox-tools.ts";

test("test-like commands are recognised by a heuristic", () => {
  for (const command of ["npm test", "npm run check", "pnpm typecheck", "npx vitest run", "cd api && pytest -q", "cargo test -p core", "go test ./...", "mix test", "bundle exec rspec", "node --test test/*.test.ts", "python -m unittest"]) {
    assert.ok(isTestCommand(command), command);
  }
  for (const command of ["FORCE_COLOR=0 npx vitest run", "./gradlew test", "git add -A && npm test", "node --experimental-strip-types --test", "bundle exec rspec spec/a_spec.rb"]) {
    assert.ok(isTestCommand(command), command);
  }
  // Named as an argument or in quotes, a runner is not a test run: a green `git commit` must not pass for one.
  for (const command of ["git checkout -b x", "test -f a && echo y", "grep -rn test src", "ls tests", "npm install", "npm install -D vitest", "grep -rn jest package.json", 'git commit -m "test: cover export with vitest"', "git commit -m 'make test pass'", 'echo "run npm test"']) {
    assert.ok(!isTestCommand(command), command);
  }
});

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

test("the bash wrapper hands the listener a clipped tail of the output", async () => {
  const vm: any = {
    exec: () =>
      Object.assign(Promise.resolve({ exitCode: 2 }), {
        output: async function* () {
          yield { data: Buffer.from("x".repeat(1_500)) };
          yield { data: Buffer.from("\nError: the end") };
        },
      }),
  };
  const tools = new Map<string, any>();
  const tails: string[] = [];
  registerSandboxTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => undefined } as any,
    "/host/clone",
    async () => ({ vm, shellPath: "/bin/sh", env: {}, root: "/host/clone" }),
    (_command, _exitCode, tail) => void tails.push(tail),
  );
  await assert.rejects(tools.get("bash").execute("1", { command: "make" }, undefined, undefined, {}));
  assert.equal(tails[0]!.length, OUTPUT_TAIL);
  assert.ok(tails[0]!.endsWith("\nError: the end"));
});

test("a worker result may carry the last test run", () => {
  const base = { version: 1, id: "t", seq: 1, status: "done", summary: "s" };
  assert.equal(parseWorkerResult(base, "t").lastTest, undefined);
  assert.deepEqual(parseWorkerResult({ ...base, lastTest: { command: "npm test", exitCode: 0 } }, "t").lastTest, { command: "npm test", exitCode: 0 });
  assert.throws(() => parseWorkerResult({ ...base, lastTest: { command: "npm test", exitCode: "0" } }, "t"), /malformed/);
  assert.throws(() => parseWorkerResult({ ...base, lastTest: "npm test" }, "t"), /malformed/);
});

test("the worker replaces every file/shell tool with a sandboxed one and adds finish and web_search", async () => {
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
  assert.deepEqual(tools.sort(), ["bash", "edit", "find", "finish", "grep", "ls", "read", "web_search", "write"]);
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

test("a done without a passing test run is unverified, only for work that writes code", () => {
  const implement = { kind: "implement" as const };
  assert.match(unverifiedDone(implement, "done", undefined)!, /you report done but no test run was recorded\. Run the project's tests/);
  assert.match(unverifiedDone({ kind: "debug" }, "done", { command: "npm test", exitCode: 1 })!, /the last test run `npm test` exited 1/);
  assert.match(unverifiedDone({ kind: "prototype" }, "done", { command: "npm test", exitCode: -1 })!, /`npm test` did not complete/);
  assert.equal(unverifiedDone(implement, "done", { command: "npm test", exitCode: 0 }), undefined);
  assert.equal(unverifiedDone(implement, "partial", undefined), undefined);
  for (const kind of ["review", "research"] as const) assert.equal(unverifiedDone({ kind }, "done", undefined), undefined, kind);
  assert.equal(unverifiedDone({ ...implement, steerUnverifiedDone: false }, "done", undefined), undefined);
});

test("finish sends an unverified done back once per cycle, without reporting it", async () => {
  const run = async (task: Record<string, unknown>) => {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (event: any, ctx?: any) => any>();
    const dir = await mkdtemp(join(tmpdir(), "pi-lead-worker-"));
    const taskPath = join(dir, "task.json");
    const resultPath = join(dir, "result.json");
    // No sandbox config: past the check, finish fails on starting the VM.
    await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", branch: "pi-lead/x-1", title: "x", resultPath, ...task }));
    worker({
      registerFlag: () => undefined,
      getFlag: () => taskPath,
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (event: string, handler: any) => handlers.set(event, handler),
    } as any);
    const finish = (status: string) => tools.get("finish").execute("1", { status, summary: "s" }, undefined, undefined, undefined);
    const settle = async (errorMessage: string) => {
      await handlers.get("agent_end")!({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage }] });
      await handlers.get("agent_settled")!({ type: "agent_settled" });
    };
    return { finish, settle, resultPath };
  };
  const passes = async (attempt: Promise<unknown>) => {
    const outcome = await attempt.then((value: any) => value.content[0].text, (error: Error) => error.message);
    assert.doesNotMatch(outcome, /Not finished/);
  };

  const implement = await run({ kind: "implement" });
  const first = await implement.finish("done");
  assert.match(first.content[0].text, /^Not finished: you report done but no test run was recorded/);
  assert.equal(first.terminate, undefined, "the worker keeps going");
  await assert.rejects(readFile(implement.resultPath, "utf8"), "nothing is reported to the Lead");
  await passes(implement.finish("done"));

  // A result starts a new cycle: the next unverified done is sent back again.
  const settled = await run({ kind: "implement" });
  await settled.finish("done");
  await settled.settle("401 unauthorized");
  assert.equal(parseWorkerResult(JSON.parse(await readFile(settled.resultPath, "utf8")), "t").status, "blocked");
  assert.match((await settled.finish("done")).content[0].text, /^Not finished/);
  await passes(settled.finish("done"));

  await passes((await run({ kind: "implement" })).finish("partial"));
  await passes((await run({ kind: "review" })).finish("done"));
  await passes((await run({ kind: "research" })).finish("done"));
  await passes((await run({ kind: "debug", steerUnverifiedDone: false })).finish("done"));
});
