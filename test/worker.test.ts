import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkerResult } from "../src/protocol.ts";
import worker, { COMMIT_LEFTOVERS } from "../src/worker/extension.ts";

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
  await writeFile(taskPath, JSON.stringify({ version: 1, id: "t", kind: "prototype", branch: "pi-lead/x-1", title: "x", resultPath, worktreePath: worktree }));
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

async function reviewedWorker(kind = "implement", runs: Array<{ exitCode: number; stdout: string }> = []) {
  const { execFile } = await import("node:child_process");
  const git = (args: string[], cwd: string) =>
    new Promise<string>((resolve, reject) => execFile("git", args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
  const worktree = await mkdtemp(join(tmpdir(), "pi-lead-review-git-"));
  await git(["init", "-q"], worktree);
  await git(["config", "user.email", "worker@test"], worktree);
  await git(["config", "user.name", "Worker"], worktree);
  const commit = async (file: string, text: string) => {
    await writeFile(join(worktree, file), text);
    await git(["add", "-A"], worktree);
    await git(["commit", "-q", "-m", `edit ${file}`], worktree);
  };
  await commit("a.txt", "base");
  const base = await git(["rev-parse", "HEAD"], worktree);
  await commit("a.txt", "work");

  const stateDir = await mkdtemp(join(tmpdir(), "pi-lead-review-state-"));
  const taskPath = join(stateDir, "task.json");
  const resultPath = join(stateDir, "result.json");
  const review = { model: "opencode-go/reviewer", thinking: "medium" };
  await writeFile(
    taskPath,
    JSON.stringify({ version: 1, id: "t", kind, branch: "pi-lead/x-1", title: "x", task: "Make a.txt say work.", resultPath, worktreePath: worktree, base, review }),
  );
  const calls: string[][] = [];
  /** A fresh worker process on the same task, as after a /reload. */
  const boot = async () => {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (event: any, ctx?: any) => any>();
    worker(
      {
        registerFlag: () => undefined,
        getFlag: () => taskPath,
        registerTool: (tool: any) => tools.set(tool.name, tool),
        on: (event: string, handler: any) => handlers.set(event, handler),
        getSessionName: () => "x",
      } as any,
      async (argv) => {
        calls.push(argv);
        return runs.shift() ?? { exitCode: 0, stdout: "1. a.txt: finding\n" };
      },
    );
    await handlers.get("session_start")!({}, { ui: { setStatus: () => undefined } });
    const call = (name: string, params: object) => tools.get(name)!.execute("1", params, undefined, undefined, {});
    return { tools, call };
  };
  const { tools, call } = await boot();
  return { tools, calls, call, boot, commit, worktree, resultPath, base };
}

test("the review tool runs a read-only one-shot reviewer from the ticket's base, three calls at most", async () => {
  const { calls, call, base } = await reviewedWorker();
  const first = await call("review", {});
  assert.match(first.content[0].text, /Review 1\/3 .* by opencode-go\/reviewer/);
  assert.match(first.content[0].text, /<review-output untrusted>\n1\. a\.txt: finding\n<\/review-output>/);
  const argv = calls[0]!;
  for (const flag of ["--print", "--no-session", "--no-extensions", "--no-approve"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(argv[argv.indexOf("--model") + 1], "opencode-go/reviewer");
  const prompt = argv.at(-1)!;
  assert.match(prompt, new RegExp(`^/skill:code-review Fixed point: ${base}\\.`));
  assert.match(prompt, /<ticket>\nMake a\.txt say work\.\n<\/ticket>/);
  assert.doesNotMatch(prompt, /re-review/);

  await call("review", { previousFindings: "1. a.txt: finding" });
  assert.match(calls[1]!.at(-1)!, /This is a re-review[\s\S]*<previous-findings>\n1\. a\.txt: finding\n<\/previous-findings>/);
  await call("review", {});
  await assert.rejects(() => call("review", {}), /All 3 review calls are used\. Call `finish` with status `blocked`/);
  assert.equal(calls.length, 3, "the fourth call never reaches the reviewer");
});

test("finish done needs a review of the current, clean HEAD; partial never waits for one", async () => {
  const { call, commit, worktree, resultPath } = await reviewedWorker();
  await assert.rejects(() => call("finish", { status: "done", summary: "s" }), /no review covers the current HEAD/);
  await call("review", {});
  await commit("b.txt", "after review");
  await assert.rejects(() => call("finish", { status: "done", summary: "s" }), /no review covers the current HEAD/, "a commit after the review");
  await call("review", {});
  await writeFile(join(worktree, "c.txt"), "dirty");
  await assert.rejects(() => call("finish", { status: "done", summary: "s" }), /uncommitted changes/);
  await call("finish", { status: "partial", summary: "s" });
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").status, "partial");
});

test("finish done passes once the last review covers HEAD", async () => {
  const { call, resultPath } = await reviewedWorker();
  await call("review", {});
  await call("finish", { status: "done", summary: "s" });
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").status, "done");
});

test("only implement and debug workers get the review tool and its gate", async () => {
  const { tools, call, resultPath } = await reviewedWorker("prototype");
  assert.ok(!tools.has("review"));
  await call("finish", { status: "done", summary: "s" });
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").status, "done");
});

test("a failed or empty reviewer run uses a review call and never unlocks finish", async () => {
  const { call, calls } = await reviewedWorker("implement", [
    { exitCode: 1, stdout: "boom" },
    { exitCode: 0, stdout: "  \n" },
    { exitCode: 2, stdout: "boom" },
  ]);
  await assert.rejects(() => call("review", {}), /reviewer failed \(exit 1\); 2 review calls left; call review again/);
  await assert.rejects(() => call("finish", { status: "done", summary: "s" }), /no review covers the current HEAD/);
  await assert.rejects(() => call("review", {}), /reviewer failed \(empty output\); 1 review call left/);
  await assert.rejects(() => call("finish", { status: "done", summary: "s" }), /no review covers the current HEAD/);
  await assert.rejects(() => call("review", {}), /no review calls left; call `finish` with status `blocked`/);
  await assert.rejects(() => call("review", {}), /All 3 review calls are used/);
  assert.equal(calls.length, 3);
});

test("an empty diff skips the reviewer, costs no call, and counts as reviewed", async () => {
  const { call, calls, commit, resultPath } = await reviewedWorker();
  await commit("a.txt", "base");
  const result = await call("review", {});
  assert.match(result.content[0].text, /^No changes to review/);
  assert.equal(calls.length, 0);
  assert.equal(result.details.reviews, 0);
  await call("finish", { status: "done", summary: "s" });
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").status, "done");
});

test("review refuses a dirty tree without calling the reviewer", async () => {
  const { call, calls, worktree } = await reviewedWorker();
  await writeFile(join(worktree, "c.txt"), "dirty");
  await assert.rejects(() => call("review", {}), /Commit your changes before calling review/);
  assert.equal(calls.length, 0);
});

test("the review count and reviewed HEAD survive a reload of the worker", async () => {
  const { call, boot, resultPath } = await reviewedWorker();
  await call("review", {});
  const reloaded = await boot();
  await reloaded.call("review", {});
  await reloaded.call("review", {});
  await assert.rejects(() => reloaded.call("review", {}), /All 3 review calls are used/);
  const again = await boot();
  await again.call("finish", { status: "done", summary: "s" });
  assert.equal(parseWorkerResult(JSON.parse(await readFile(resultPath, "utf8")), "t").status, "done");
});
