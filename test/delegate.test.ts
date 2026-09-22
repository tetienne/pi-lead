import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { createDelegator, isSafeBranchName, shellQuote, slugify, type DelegateIO } from "../src/delegate.ts";
import type { Herdr } from "../src/herdr.ts";
import type { Judge, WorkerVerdict } from "../src/jev.ts";
import type { WorkerTask } from "../src/protocol.ts";
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

function fakeWorkspace(log: Log): Workspace {
  return {
    repoRoot: async (cwd) => cwd,
    create: async ({ branch, startFrom }) => {
      log.push(`create ${branch}${startFrom ? ` from ${startFrom}` : ""}`);
      return { base: "abc123" };
    },
    collect: async ({ branch }) => ({ commits: `def456 work on ${branch}`, diffStat: " src/a.ts | 3 ++-" }),
    remove: async (path) => void log.push(`remove ${path.endsWith("repo") ? "clone" : path}`),
  };
}

/** Simulates the worker: reads the task file the script points at and writes a result. */
function fakeHerdr(log: Log, outcome: { status: WorkerVerdict; summary?: string; findings?: string; delayMs?: number }): Herdr {
  let tabs = 0;
  return {
    async openWorkerTab({ label, argv }) {
      const tabId = `tab-${++tabs}`;
      log.push(`open ${label}`);
      const script = await readFile(argv[1]!, "utf8");
      const taskPath = /'--pi-lead-task' '([^']+)'/.exec(script)?.[1];
      assert.ok(taskPath, "script passes the task file");
      const task = JSON.parse(await readFile(taskPath, "utf8")) as WorkerTask;
      setTimeout(() => {
        void writeFile(
          task.resultPath,
          JSON.stringify({ version: 1, id: task.id, status: outcome.status, summary: outcome.summary ?? "did it", ...(outcome.findings ? { findings: outcome.findings } : {}) }),
        );
      }, outcome.delayMs ?? 5);
      return { tabId, paneId: `pane-${tabs}` };
    },
    async closeTab(tabId) {
      log.push(`close ${tabId}`);
    },
  };
}

const io = (progress: string[] = []): DelegateIO => ({
  cwd: "/repo",
  lead: { provider: "anthropic", id: "claude-sonnet-5" },
  available: [{ provider: "anthropic", id: "claude-sonnet-5" }],
  progress: (text) => void progress.push(text),
});

async function setup(options: { judge?: Partial<Judge>; outcome?: Parameters<typeof fakeHerdr>[1]; herdr?: false; maxWorkers?: number } = {}) {
  const log: Log = [];
  const delegator = createDelegator({
    config: mergeConfig(DEFAULT_CONFIG, { maxWorkers: options.maxWorkers ?? 2 }),
    judge: { ...noJudge, ...options.judge },
    herdr: options.herdr === false ? undefined : fakeHerdr(log, options.outcome ?? { status: "done" }),
    workspace: fakeWorkspace(log),
    workerCommand: ({ taskPath, prompt, route }) => ["pi", "--model", route.model, "--thinking", route.thinking, "--pi-lead-task", taskPath, "--", prompt],
    stateRoot: await mkdtemp(join(tmpdir(), "pi-lead-state-")),
    pollMs: 2,
    heartbeatMs: 20,
  });
  return { delegator, log };
}

test("helpers: slug, branch validation and shell quoting", () => {
  assert.equal(slugify("Add CSV export (v2)!"), "add-csv-export-v2");
  assert.ok(isSafeBranchName("feature/login"));
  assert.ok(!isSafeBranchName("-rf"));
  assert.ok(!isSafeBranchName("a..b"));
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
});

test("a finished worker returns its summary, branch and diff, then cleans up", async () => {
  const { delegator, log } = await setup();
  const outcome = await delegator.run({ kind: "implement", title: "Add CSV export", task: "Add CSV export. AC: test passes." }, io());
  assert.equal(outcome.status, "done");
  assert.match(outcome.text, /Branch: pi-lead\/add-csv-export-/);
  assert.match(outcome.text, /src\/a\.ts/);
  assert.match(outcome.text, /anthropic\/claude-sonnet-5 · thinking medium · tier standard \(default tier; Jev unavailable\)/);
  assert.deepEqual(log.filter((line) => !line.startsWith("create")), ["open lead: Add CSV export", "close tab-1", "remove clone"]);
  assert.equal(delegator.activeCount(), 0);
});

test("Jev picks the tier and a pessimistic Jev verdict keeps the tab", async () => {
  const { delegator, log } = await setup({
    judge: {
      available: true,
      modelTier: async () => ({ tier: "deep", difficulty: 3.4 }),
      verdict: async () => "partial",
    },
  });
  const outcome = await delegator.run({ kind: "implement", title: "Hard", task: "t" }, io());
  assert.equal(outcome.status, "partial");
  assert.match(outcome.text, /thinking high · tier deep \(Jev difficulty 3\.4\/4\)/);
  assert.match(outcome.text, /worker said done, Jev said partial/);
  assert.ok(!log.some((line) => line.startsWith("close")));
});

test("a ticket Jev judges not ready is not delegated unless the user confirmed it", async () => {
  const judge = { readiness: async () => ({ ready: false, missing: ["acceptance"] }) };
  const { delegator, log } = await setup({ judge });
  const refused = await delegator.run({ kind: "implement", title: "Vague", task: "make it nicer" }, io());
  assert.equal(refused.status, "not_ready");
  assert.match(refused.text, /no verifiable acceptance criteria/);
  assert.equal(log.length, 0);
  const confirmed = await delegator.run({ kind: "implement", title: "Vague", task: "make it nicer", confirmedReady: true }, io());
  assert.equal(confirmed.status, "done");
});

test("reviews start from the reviewed branch and report Jev's severity", async () => {
  const { delegator, log } = await setup({
    outcome: { status: "done", findings: "SQL injection in search" },
    judge: { reviewSeverity: async () => ({ severity: 3.8, action: "escalate" }) },
  });
  const outcome = await delegator.run({ kind: "review", title: "Review login", task: "Review against main", startFrom: "feature/login" }, io());
  assert.ok(log.some((line) => line.endsWith("from feature/login")));
  assert.match(outcome.text, /SQL injection/);
  assert.match(outcome.text, /serious issues: show them to the user/);
});

test("overlapping code tickets run one after the other", async () => {
  const { delegator, log } = await setup({ outcome: { status: "done", delayMs: 30 }, judge: { overlap: async () => true } });
  const progress: string[] = [];
  const [first, second] = await Promise.all([
    delegator.run({ kind: "implement", title: "One", task: "a" }, io()),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return delegator.run({ kind: "implement", title: "Two", task: "b" }, io(progress));
    })(),
  ]);
  assert.equal(first.status, "done");
  assert.equal(second.status, "done");
  assert.ok(log.indexOf("close tab-1") < log.indexOf("open lead: Two"));
  assert.ok(progress.some((line) => line.startsWith("waiting for overlapping worker")));
});

test("independent tickets run in parallel", async () => {
  const { delegator, log } = await setup({ outcome: { status: "done", delayMs: 30 }, judge: { overlap: async () => false } });
  await Promise.all([
    delegator.run({ kind: "implement", title: "One", task: "a" }, io()),
    delegator.run({ kind: "implement", title: "Two", task: "b" }, io()),
  ]);
  assert.ok(log.indexOf("open lead: Two") < log.indexOf("close tab-1"));
});

test("without Herdr or with a bad branch name nothing starts", async () => {
  const { delegator } = await setup({ herdr: false });
  assert.match((await delegator.run({ kind: "debug", title: "x", task: "y" }, io())).text, /need Herdr/);
  const { delegator: other, log } = await setup();
  assert.equal((await other.run({ kind: "review", title: "x", task: "y", startFrom: "--upload-pack=evil" }, io())).status, "failed");
  assert.equal(log.length, 0);
});

test("cancelling the tool stops waiting and cleans up", async () => {
  const { delegator, log } = await setup({ outcome: { status: "done", delayMs: 10_000 } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user pressed escape")), 20);
  const outcome = await delegator.run({ kind: "research", title: "Slow", task: "q" }, { ...io(), signal: controller.signal });
  assert.equal(outcome.status, "cancelled");
  assert.ok(log.includes("close tab-1"));
});
