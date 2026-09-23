import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import {
  createDelegator,
  isSafeBranchName,
  shellQuote,
  slugify,
  type DelegateIO,
  type DelegateOutcome,
} from "../src/delegate.ts";
import type { Herdr } from "../src/herdr.ts";
import type { Judge, WorkerVerdict } from "../src/jev.ts";
import type { WorkerTask } from "../src/protocol.ts";
import type { Toolchains } from "../src/toolchains.ts";
import type { Workspace } from "../src/workspace.ts";

const noJudge: Judge = {
  available: false,
  modelTier: async () => undefined,
  readiness: async () => undefined,
  egress: async () => "ask",
  verdict: async () => undefined,
  reviewSeverity: async () => undefined,
  failureKind: async () => undefined,
  overlap: async () => undefined,
};

type Log = string[];
type Reply = { status: WorkerVerdict; summary?: string; findings?: string; delayMs?: number } | "exit" | "silent";

function fakeWorkspace(log: Log): Workspace {
  return {
    repoRoot: async (cwd) => cwd,
    create: async ({ branch, startFrom }) => {
      log.push(`create ${branch}${startFrom ? ` from ${startFrom}` : ""}`);
      return { base: "abc123" };
    },
    collect: async ({ branch }) => ({ commits: `def456 work on ${branch}`, diffStat: " src/a.ts | 3 ++-" }),
    remove: async () => void log.push("remove clone"),
  };
}

const scriptOf = (command: string) => /^\/bin\/sh '([^']+)'$/.exec(command)![1]!;

/**
 * A fake Herdr whose "worker" reads the task file from the launch script and
 * replies: first with `replies[0]`, then with the next reply after each message.
 */
function fakeHerdr(log: Log, replies: Reply[], seen: { task?: WorkerTask; script?: string } = {}): Herdr {
  let tabs = 0;
  const workers = new Map<string, { task: WorkerTask; exitPath: string; seq: number; turn: number }>();
  const reply = (paneId: string) => {
    const worker = workers.get(paneId)!;
    const next = replies[Math.min(worker.turn++, replies.length - 1)]!;
    if (next === "silent") return;
    if (next === "exit") return void setTimeout(() => void writeFile(worker.exitPath, "1\n"), 5);
    setTimeout(() => {
      void writeFile(
        worker.task.resultPath,
        JSON.stringify({ version: 1, id: worker.task.id, seq: ++worker.seq, status: next.status, summary: next.summary ?? "did it", ...(next.findings ? { findings: next.findings } : {}) }),
      );
    }, next.delayMs ?? 5);
  };
  return {
    async openWorkerTab({ label, command }) {
      const tabId = `tab-${++tabs}`;
      const paneId = `pane-${tabs}`;
      log.push(`open ${label}`);
      const script = await readFile(scriptOf(command), "utf8");
      seen.script = script;
      const task = JSON.parse(await readFile(/'--pi-lead-task' '([^']+)'/.exec(script)![1]!, "utf8")) as WorkerTask;
      seen.task = task;
      workers.set(paneId, { task, exitPath: /echo \$\? > '([^']+)'/.exec(script)![1]!, seq: 0, turn: 0 });
      reply(paneId);
      return { tabId, paneId };
    },
    async sendToAgent(paneId, text) {
      log.push(`send ${paneId}: ${text}`);
      reply(paneId);
    },
    async closeTab(tabId) {
      log.push(`close ${tabId}`);
    },
  };
}

const io: DelegateIO = {
  cwd: "/repo",
  lead: { provider: "anthropic", id: "claude-sonnet-5" },
  available: [{ provider: "anthropic", id: "claude-sonnet-5" }],
  projectTrusted: true,
};

async function setup(t: TestContext, options: {
  judge?: Partial<Judge>;
  replies?: Reply[];
  herdr?: Herdr | false;
  maxWorkers?: number;
  toolchains?: Toolchains;
  seen?: { task?: WorkerTask; script?: string };
} = {}) {
  const log: Log = [];
  const outcomes: DelegateOutcome[] = [];
  const waiters: Array<(outcome: DelegateOutcome) => void> = [];
  const progress: string[] = [];
  const delegator = createDelegator({
    config: mergeConfig(DEFAULT_CONFIG, { maxWorkers: options.maxWorkers ?? 2 }),
    judge: { ...noJudge, ...options.judge },
    herdr: options.herdr === false ? undefined : options.herdr ?? fakeHerdr(log, options.replies ?? [{ status: "done" }], options.seen),
    workspace: fakeWorkspace(log),
    ...(options.toolchains ? { toolchains: options.toolchains } : {}),
    workerCommand: ({ taskPath, prompt, route }) => ["pi", "--model", route.model, "--thinking", route.thinking, "--pi-lead-task", taskPath, "--", prompt],
    stateRoot: await mkdtemp(join(tmpdir(), "pi-lead-state-")),
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      waiters.shift()?.(outcome);
    },
    onProgress: (text) => void progress.push(text),
    pollMs: 2,
    heartbeatMs: 20,
  });
  // Workers left waiting on a question are watched until stopped.
  t.after(() => delegator.shutdown());
  const nextOutcome = () =>
    new Promise<DelegateOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no outcome")), 3_000);
      waiters.push((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  return { delegator, log, outcomes, nextOutcome, progress };
}

test("helpers: slug, branch validation and shell quoting", () => {
  assert.equal(slugify("Add CSV export (v2)!"), "add-csv-export-v2");
  assert.ok(isSafeBranchName("feature/login"));
  assert.ok(!isSafeBranchName("-rf"));
  assert.ok(!isSafeBranchName("a..b"));
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
});

test("delegate returns at once; the result arrives later, then the worker is cleaned up", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, { replies: [{ status: "done", delayMs: 30 }] });
  const pending = nextOutcome();
  const started = await delegator.start({ kind: "implement", title: "Add CSV export", task: "Add CSV export. AC: test passes." }, io);
  assert.equal(started.status, "started");
  assert.match(started.text, /result will arrive as a message/);
  assert.equal(delegator.list()[0]!.state === "done", false, "not finished when start returns");

  const outcome = await pending;
  assert.equal(outcome.status, "done");
  assert.match(outcome.text, /Branch: pi-lead\/add-csv-export-/);
  assert.match(outcome.text, /src\/a\.ts/);
  assert.match(outcome.text, /anthropic\/claude-sonnet-5 · thinking medium · tier standard \(default tier; Jev unavailable\)/);
  assert.deepEqual(log.filter((line) => !line.startsWith("create")), ["open lead: Add CSV export", "close tab-1", "remove clone"]);
  assert.equal(delegator.list()[0]!.state, "done");
});

test("a worker waiting on a question gets the relayed answer and reports again", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, {
    replies: [{ status: "needs_human", summary: "Which date format?" }, { status: "done", summary: "Used ISO 8601" }],
  });
  const first = nextOutcome();
  const started = await delegator.start({ kind: "implement", title: "Dates", task: "t" }, io);
  assert.ok(started.status === "started");
  const question = await first;
  assert.equal(question.status, "needs_human");
  assert.match(question.text, /relay what it needs with `worker`/);
  assert.equal(delegator.list()[0]!.state, "waiting");
  assert.ok(!log.some((line) => line.startsWith("close")), "tab stays open");

  const second = nextOutcome();
  assert.match(await delegator.message(started.worker.id.slice(0, 8), "ISO 8601, please"), /Sent to "Dates"/);
  assert.ok(log.includes("send pane-1: [PI Lead] ISO 8601, please"));
  const answer = await second;
  assert.equal(answer.status, "done");
  assert.match(answer.text, /Used ISO 8601/);
  assert.ok(log.includes("close tab-1"));
});

test("Jev picks the tier and a pessimistic Jev verdict keeps the tab", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, {
    judge: { available: true, modelTier: async () => ({ tier: "deep", difficulty: 3.4 }), verdict: async () => "partial" },
  });
  const pending = nextOutcome();
  const started = await delegator.start({ kind: "implement", title: "Hard", task: "t" }, io);
  assert.match(started.text, /thinking high, tier deep, Jev difficulty 3\.4\/4/);
  const outcome = await pending;
  assert.equal(outcome.status, "partial");
  assert.match(outcome.text, /worker said done, Jev said partial/);
  assert.ok(!log.some((line) => line.startsWith("close")));
});

test("a ticket Jev judges not ready is not delegated unless the user confirmed it", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, { judge: { readiness: async () => ({ ready: false, missing: ["acceptance"] }) } });
  const refused = await delegator.start({ kind: "implement", title: "Vague", task: "make it nicer" }, io);
  assert.equal(refused.status, "not_ready");
  assert.match(refused.text, /no verifiable acceptance criteria/);
  assert.equal(log.length, 0);
  const pending = nextOutcome();
  assert.equal((await delegator.start({ kind: "implement", title: "Vague", task: "make it nicer", confirmedReady: true }, io)).status, "started");
  assert.equal((await pending).status, "done");
});

test("reviews start from the reviewed branch and report Jev's severity", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, {
    replies: [{ status: "done", findings: "SQL injection in search" }],
    judge: { reviewSeverity: async () => ({ severity: 3.8, action: "escalate" }) },
  });
  const pending = nextOutcome();
  await delegator.start({ kind: "review", title: "Review login", task: "Review against main", startFrom: "feature/login" }, io);
  const outcome = await pending;
  assert.ok(log.some((line) => line.endsWith("from feature/login")));
  assert.match(outcome.text, /SQL injection/);
  assert.match(outcome.text, /serious issues: show them to the user/);
});

test("overlapping code tickets run one after the other", async (t) => {
  const { delegator, log, nextOutcome, progress } = await setup(t, { replies: [{ status: "done", delayMs: 30 }], judge: { overlap: async () => true } });
  const both = [nextOutcome(), nextOutcome()];
  await delegator.start({ kind: "implement", title: "One", task: "a" }, io);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await delegator.start({ kind: "implement", title: "Two", task: "b" }, io);
  await Promise.all(both);
  assert.ok(log.indexOf("close tab-1") < log.indexOf("open lead: Two"));
  assert.ok(progress.some((line) => line.includes('waits for overlapping "One"')));
});

test("independent tickets run in parallel", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, { replies: [{ status: "done", delayMs: 30 }], judge: { overlap: async () => false } });
  const both = [nextOutcome(), nextOutcome()];
  await delegator.start({ kind: "implement", title: "One", task: "a" }, io);
  await delegator.start({ kind: "implement", title: "Two", task: "b" }, io);
  await Promise.all(both);
  assert.ok(log.indexOf("open lead: Two") < log.indexOf("close tab-1"));
});

test("without Herdr or with a bad branch name nothing starts", async (t) => {
  const { delegator } = await setup(t, { herdr: false });
  assert.match((await delegator.start({ kind: "debug", title: "x", task: "y" }, io)).text, /need Herdr/);
  const { delegator: other, log } = await setup(t);
  assert.equal((await other.start({ kind: "review", title: "x", task: "y", startFrom: "--upload-pack=evil" }, io)).status, "failed");
  assert.equal(log.length, 0);
});

test("stopping a worker closes its tab and reports it", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, { replies: ["silent"] });
  const pending = nextOutcome();
  const started = await delegator.start({ kind: "research", title: "Slow", task: "q" }, io);
  assert.ok(started.status === "started");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(await delegator.stop("slow"), /Stopping "Slow"/);
  const outcome = await pending;
  assert.equal(outcome.status, "stopped");
  assert.ok(log.includes("close tab-1"));
  assert.match(await delegator.message("slow", "hello"), /is stopped; it cannot receive messages/);
});

test("a worker whose Pi exits without finish is reported as failed", async (t) => {
  const { delegator, nextOutcome } = await setup(t, { replies: ["exit"] });
  const pending = nextOutcome();
  await delegator.start({ kind: "debug", title: "x", task: "y" }, io);
  const outcome = await pending;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.text, /exited \(status 1\) without calling finish/);
});

test("the launch script and the task carry the toolchain cache and Herdr hint", async (t) => {
  const seen: { task?: WorkerTask; script?: string } = {};
  const { delegator, nextOutcome } = await setup(t, { seen, toolchains: { prepare: async () => "/cache/project" } });
  const pending = nextOutcome();
  await delegator.start({ kind: "implement", title: "x", task: "y" }, io);
  await pending;
  assert.equal(seen.task?.toolchainCache, "/cache/project");
  assert.match(seen.script!, /export HERDR_AGENT=pi/);
});

test("a Lead that throws on delivery does not take the watcher down", async (t) => {
  const log: string[] = [];
  const delegator = createDelegator({
    config: DEFAULT_CONFIG,
    judge: noJudge,
    herdr: fakeHerdr(log, [{ status: "done" }]),
    workspace: fakeWorkspace(log),
    workerCommand: ({ taskPath }) => ["pi", "--pi-lead-task", taskPath],
    stateRoot: await mkdtemp(join(tmpdir(), "pi-lead-state-")),
    onOutcome: () => {
      throw new Error("stale session");
    },
    pollMs: 2,
    heartbeatMs: 20,
  });
  t.after(() => delegator.shutdown());
  await delegator.start({ kind: "implement", title: "x", task: "y" }, io);
  for (let i = 0; i < 100 && delegator.list()[0]!.state !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(delegator.list()[0]!.state, "done");
  assert.ok(log.includes("close tab-1"), "cleanup still ran");
});

test("messages are refused once the worker's Pi has exited", async (t) => {
  const seen: { task?: WorkerTask; script?: string } = {};
  const { delegator, log, nextOutcome } = await setup(t, { seen, replies: [{ status: "needs_human" }] });
  const first = nextOutcome();
  const started = await delegator.start({ kind: "implement", title: "Q", task: "y" }, io);
  assert.ok(started.status === "started");
  await first;
  const exitPath = /echo \$\? > '([^']+)'/.exec(seen.script!)![1]!;
  await writeFile(exitPath, "0\n");
  assert.match(await delegator.message("q", "go on"), /has exited/);
  assert.ok(!log.some((line) => line.startsWith("send")), "nothing is typed anywhere");
});

test("shutdown stops live workers and waits for their cleanup", async (t) => {
  const { delegator, log, outcomes } = await setup(t, { replies: ["silent"] });
  await delegator.start({ kind: "research", title: "Long", task: "q" }, io);
  for (let i = 0; i < 100 && !log.some((line) => line.startsWith("open")); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await delegator.shutdown();
  assert.ok(log.includes("close tab-1"));
  assert.equal(outcomes.at(-1)?.status, "stopped");
});

test("queued overlapping tickets start one at a time, in order", async (t) => {
  const { delegator, log, nextOutcome } = await setup(t, { replies: [{ status: "done", delayMs: 20 }], judge: { overlap: async () => true } });
  const all = [nextOutcome(), nextOutcome(), nextOutcome()];
  for (const title of ["A", "B", "C"]) await delegator.start({ kind: "implement", title, task: title }, io);
  await Promise.all(all);
  const opens = log.filter((line) => line.startsWith("open") || line.startsWith("close"));
  assert.deepEqual(opens, ["open lead: A", "close tab-1", "open lead: B", "close tab-2", "open lead: C", "close tab-3"]);
});

test("a queued worker can be stopped before its turn", async (t) => {
  const { delegator, nextOutcome } = await setup(t, { replies: ["silent"], maxWorkers: 1 });
  await delegator.start({ kind: "research", title: "First", task: "a" }, io);
  const queued = await delegator.start({ kind: "research", title: "Second", task: "b" }, io);
  assert.equal(queued.status, "queued");
  const stopped = nextOutcome();
  await delegator.stop("second");
  const outcome = await stopped;
  assert.equal(outcome.worker.title, "Second");
  assert.equal(outcome.status, "stopped");
});
