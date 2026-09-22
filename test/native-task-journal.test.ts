import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { createNativeTaskJournal } from "../src/native-task-journal.ts";
import { TaskRecordStore } from "../src/task-recovery.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: { HOME: cwd, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout.trim();
}

test("native workflow admission durably records ownership before worker dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-journal-"));
  const repository = join(root, "consumer");
  await git(root, "init", "--quiet", "--initial-branch=main", repository);
  await writeFile(join(repository, "value.txt"), "base\n");
  await git(repository, "add", "value.txt");
  await git(repository, "-c", "user.name=PI Lead Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  const journal = await createNativeTaskJournal({
    cwd: repository, taskId: "task-journal", workflow: "IMPLEMENT", namedBase: "main",
    branchName: "pi-lead/task-task-journal", stateRoot: join(root, "state"),
  });
  const stateDirectory = join(journal.stateRoot, "worker-run");
  await mkdir(stateDirectory, { recursive: true });

  await journal.workerStarted({
    effectiveRoute: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "high" },
    identity: {
      taskId: "task-journal", assignmentId: "task-journal:build:0", workerId: "worker",
      vmId: "vm", piSessionId: "session", tabId: "tab", paneId: "pane",
    },
    stateDirectory,
    phase: "BUILD",
  });
  await journal.workerObserved({
    taskId: "task-journal", assignmentId: "task-journal:build:0", workerId: "worker",
    vmId: "vm", piSessionId: "session", tabId: "tab", paneId: "pane",
  });

  const nextStateDirectory = join(journal.stateRoot, "review-run");
  await mkdir(nextStateDirectory, { recursive: true });
  await journal.workerStarted({
    effectiveRoute: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "medium" },
    identity: {
      taskId: "task-journal", assignmentId: "task-journal:review:0", workerId: "reviewer",
      vmId: "review-vm", piSessionId: "review-session", tabId: "review-tab", paneId: "review-pane",
    },
    stateDirectory: nextStateDirectory,
    phase: "VERIFY",
  });
  await journal.workerObserved({
    taskId: "task-journal", assignmentId: "task-journal:review:0", workerId: "reviewer",
    vmId: "review-vm", piSessionId: "review-session", tabId: "review-tab", paneId: "review-pane",
  });
  await journal.workerCleaned({
    taskId: "task-journal", assignmentId: "task-journal:review:0", workerId: "reviewer",
    vmId: "review-vm", piSessionId: "review-session", tabId: "review-tab", paneId: "review-pane",
  });

  const record = await new TaskRecordStore({ root: journal.stateRoot }).load("task-journal");
  assert.equal(record?.workflow, "IMPLEMENT");
  assert.equal(record?.status, "VERIFY");
  assert.equal(record?.identity.vmId, "review-vm");
  assert.deepEqual(record?.workerHistory?.map((identity) => identity.assignmentId), [
    "task-journal:build:0", "task-journal:review:0",
  ]);
  assert.deepEqual(record?.actions, [
    { id: "prompt:task-journal:build:0", kind: "PROMPT", phase: "INTENDED" },
    { id: "prompt:task-journal:build:0", kind: "PROMPT", phase: "OBSERVED" },
    { id: "prompt:task-journal:review:0", kind: "PROMPT", phase: "INTENDED" },
    { id: "prompt:task-journal:review:0", kind: "PROMPT", phase: "OBSERVED" },
  ]);
  assert.deepEqual(record?.cleanup, { vmTerminated: true, successfulTabClosed: true });
  assert.equal(record?.diagnostics.logDirectory, "review-run");
});

test("a completed standalone review becomes a durable DONE record with final-revision evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-journal-"));
  const repository = join(root, "consumer");
  await git(root, "init", "--quiet", "--initial-branch=main", repository);
  await writeFile(join(repository, "value.txt"), "base\n");
  await git(repository, "add", "value.txt");
  await git(repository, "-c", "user.name=PI Lead Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  const commit = await git(repository, "rev-parse", "HEAD");
  const journal = await createNativeTaskJournal({
    cwd: repository, taskId: "task-review", workflow: "REVIEW", namedBase: "main",
    branchName: "main", stateRoot: join(root, "state"),
  });
  const stateDirectory = join(journal.stateRoot, "review-run");
  await mkdir(stateDirectory, { recursive: true });
  await journal.workerStarted({
    effectiveRoute: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "high" },
    identity: { taskId: "task-review", assignmentId: "review-1", workerId: "worker", vmId: "vm", piSessionId: "session", tabId: "tab", paneId: "pane" },
    stateDirectory,
    phase: "VERIFY",
  });
  await journal.recordReview({
    status: "DONE", taskId: "task-review", comparisonSource: `git:${commit}..${commit}`,
    reports: [{
      taskId: "task-review", axis: "STANDARDS", reviewerId: "worker", contextId: "session",
      comparisonSource: `git:${commit}..${commit}`, standardsDigest: "d".repeat(64), findings: [],
      readOnly: true, published: false,
    }],
    specification: { status: "MISSING_SPECIFICATION" }, readOnly: true, published: false,
  });

  const record = await new TaskRecordStore({ root: journal.stateRoot }).load("task-review");
  assert.equal(record?.status, "DONE");
  assert.equal(record?.finalCommit, commit);
  assert.equal(record?.verification.independentReviewArtifactIds.length, 1);
  assert.equal(record?.actions.at(-1)?.phase, "OBSERVED");
});

test("a validated compatibility proposal remains blocked at its human review gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-journal-"));
  const repository = join(root, "consumer");
  await git(root, "init", "--quiet", "--initial-branch=main", repository);
  await writeFile(join(repository, "value.txt"), "base\n");
  await git(repository, "add", "value.txt");
  await git(repository, "-c", "user.name=PI Lead Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  const journal = await createNativeTaskJournal({
    cwd: repository, taskId: "task-change", workflow: "CHANGE", namedBase: "main",
    branchName: "pi-lead/proposal-task-change", stateRoot: join(root, "state"),
  });
  const identity = {
    taskId: "task-change", assignmentId: "change-1", workerId: "worker", vmId: "vm",
    piSessionId: "session", tabId: "tab", paneId: "pane",
  };
  const stateDirectory = join(journal.stateRoot, "change-run");
  await mkdir(stateDirectory, { recursive: true });
  await journal.workerStarted({ identity, stateDirectory, phase: "BUILD" });
  await journal.workerObserved(identity);
  await journal.workerCleaned(identity);
  await journal.recordChange({
    status: "REVIEW_REQUIRED", ...identity, baseCommit, proposedCommit: "b".repeat(40),
    validations: [{ task: "test", command: "mise run test", passed: true, exitCode: 0 }],
    artifactId: "proposal-artifact", files: [], humanGate: true, hostCommitted: false,
    published: false, vmTerminated: true,
  });

  const record = await new TaskRecordStore({ root: journal.stateRoot }).load("task-change");
  assert.equal(record?.status, "BLOCKED");
  assert.equal(record?.blockedReason, "HUMAN_REVIEW_REQUIRED");
  assert.equal(record?.finalCommit, undefined);
  assert.equal(record?.verification.finalRevisionVerified, false);
  assert.deepEqual(record?.verification.checks, ["mise run test"]);
});
