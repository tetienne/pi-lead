import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TaskRecordStore,
  confirmRecoveredTask,
  reconcileInterruptedTask,
  type DurableTaskRecord,
  type RecoveryRuntime,
} from "../src/task-recovery.ts";

const identity = {
  taskId: "task-6",
  assignmentId: "task-6:build:0",
  workerId: "worker-6",
  vmId: "vm-6",
  piSessionId: "session-6",
  tabId: "tab-6",
  paneId: "pane-6",
};

function interruptedRecord(overrides: Partial<DurableTaskRecord> = {}): DurableTaskRecord {
  return {
    schemaVersion: 1,
    taskId: identity.taskId,
    status: "BUILD",
    identity,
    baseCommit: "a".repeat(40),
    branchName: "pi-lead/task-task-6",
    actions: [{ id: "prompt-1", kind: "PROMPT", phase: "INTENDED" }],
    attempts: 1,
    approvals: [],
    verification: {
      finalRevisionVerified: false,
      checks: [],
      independentReviewArtifactIds: [],
      correctionCycles: 0,
    },
    artifacts: [],
    cleanup: { vmTerminated: false, successfulTabClosed: false },
    diagnostics: { outcome: "FAILURE", logDirectory: "diagnostics/task-6" },
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

function runtime(overrides: Partial<RecoveryRuntime> = {}): RecoveryRuntime {
  return {
    async vm(identity) { return { state: "STOPPED", identity }; },
    async pi(identity) { return { state: "STOPPED", identity }; },
    async herdrTab(identity) { return { state: "PRESENT", identity }; },
    async git() { return { commit: "a".repeat(40) }; },
    async terminateVm() { return true; },
    ...overrides,
  };
}

test("recovery records an uncertain prompt without replaying it and requires separate resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord());
  let terminateCalls = 0;

  const result = await reconcileInterruptedTask(store, identity.taskId, runtime({
    async terminateVm() { terminateCalls++; return true; },
  }));

  assert.equal(terminateCalls, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "UNCERTAIN_ACTION");
  assert.equal(result.resumeAllowed, false);
  assert.equal((await store.load(identity.taskId))?.actions[0]?.phase, "INTENDED");
  await assert.rejects(confirmRecoveredTask(store, identity.taskId), /unresolved uncertain action/);
});

test("a durable task store serializes concurrent controller updates for one project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const first = new TaskRecordStore({ root });
  await Promise.all([
    first.save(interruptedRecord({ updatedAt: "2026-09-21T10:01:00.000Z" })),
    first.save(interruptedRecord({ updatedAt: "2026-09-21T10:02:00.000Z" })),
  ]);
  assert.ok((await first.load(identity.taskId))?.updatedAt);
});

test("the host can enumerate unfinished durable tasks for Lead restart admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord());
  await store.save(interruptedRecord({
    taskId: "task-done",
    identity: { ...identity, taskId: "task-done" },
    status: "DONE",
    actions: [
      { id: "prompt-1", kind: "PROMPT", phase: "INTENDED" },
      { id: "prompt-1", kind: "PROMPT", phase: "OBSERVED" },
    ],
    finalCommit: "b".repeat(40),
    verification: {
      finalRevisionVerified: true,
      checks: ["npm test"],
      independentReviewArtifactIds: ["standards", "spec"],
      correctionCycles: 0,
    },
    artifacts: ["artifacts/task-done.json"],
    cleanup: { vmTerminated: true, successfulTabClosed: true },
    diagnostics: {
      outcome: "SUCCESS",
      logDirectory: "logs/task-done",
      completedAt: "2026-09-21T10:01:00.000Z",
    },
  }));

  assert.deepEqual(await store.listInterruptedTaskIds(), ["task-6"]);
});

test("a mismatched observed action cannot resolve an intended prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord({ actions: [
    { id: "action-1", kind: "PROMPT", phase: "INTENDED" },
    { id: "action-1", kind: "PUSH", phase: "INTENDED" },
    { id: "action-1", kind: "PUSH", phase: "OBSERVED" },
  ] }));

  const result = await reconcileInterruptedTask(store, identity.taskId, runtime());
  assert.equal(result.reason, "UNCERTAIN_ACTION");
});

test("recovery stops and re-observes a surviving worker before reporting an uncertain side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord());
  let vmChecks = 0;
  const result = await reconcileInterruptedTask(store, identity.taskId, runtime({
    async vm(observed) {
      vmChecks++;
      return { state: vmChecks === 1 ? "RUNNING" : "STOPPED", identity: observed };
    },
  }));

  assert.equal(vmChecks, 2);
  assert.equal(result.reason, "UNCERTAIN_ACTION");
  assert.equal(result.record.cleanup.vmTerminated, true);
});

test("recovery terminates a surviving worker, retains its diagnostic tab, and only then allows confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord({ actions: [
    { id: "prompt-1", kind: "PROMPT", phase: "INTENDED" },
    { id: "prompt-1", kind: "PROMPT", phase: "OBSERVED" },
  ] }));
  const calls: string[] = [];
  let vmChecks = 0;
  const result = await reconcileInterruptedTask(store, identity.taskId, runtime({
    async vm(observed) {
      calls.push("vm");
      vmChecks++;
      return { state: vmChecks === 1 ? "RUNNING" : "STOPPED", identity: observed };
    },
    async terminateVm(observed) { calls.push(`terminate:${observed.vmId}`); return true; },
  }));

  assert.deepEqual(calls, ["vm", "terminate:vm-6", "vm"]);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "RESUME_CONFIRMATION_REQUIRED");
  assert.equal(result.diagnosticsRetained, true);
  assert.equal(result.resumeAllowed, true);
  assert.equal((await confirmRecoveredTask(store, identity.taskId)).status, "READY");
});

test("recovery blocks a stale resource identity and a failed cleanup remains actionable after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await store.save(interruptedRecord({ actions: [
    { id: "prompt-1", kind: "PROMPT", phase: "INTENDED" },
    { id: "prompt-1", kind: "PROMPT", phase: "OBSERVED" },
  ] }));

  const stale = await reconcileInterruptedTask(store, identity.taskId, runtime({
    async vm(observed) { return { state: "RUNNING", identity: { ...observed, workerId: "replacement" } }; },
  }));
  assert.equal(stale.reason, "IDENTITY_MISMATCH");
  assert.equal(stale.resumeAllowed, false);

  await store.save(interruptedRecord({ actions: [
    { id: "prompt-1", kind: "PROMPT", phase: "INTENDED" },
    { id: "prompt-1", kind: "PROMPT", phase: "OBSERVED" },
  ] }));
  const cleanup = await reconcileInterruptedTask(store, identity.taskId, runtime({
    async vm(observed) { return { state: "RUNNING", identity: observed }; },
    async terminateVm() { return false; },
  }));
  assert.equal(cleanup.reason, "CLEANUP_UNCONFIRMED");
  assert.equal(cleanup.resumeAllowed, false);
  assert.equal((await store.load(identity.taskId))?.cleanup.vmTerminated, false);
});

test("a DONE record requires collected artifacts, independent review, resolved actions, and confirmed cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  await assert.rejects(store.save(interruptedRecord({
    status: "DONE",
    finalCommit: "b".repeat(40),
    cleanup: { vmTerminated: true, successfulTabClosed: true },
    diagnostics: { outcome: "SUCCESS", logDirectory: "logs/task-6", completedAt: "2026-09-21T10:01:00.000Z" },
    verification: {
      finalRevisionVerified: true,
      checks: ["npm test"],
      independentReviewArtifactIds: ["review-standards"],
      correctionCycles: 0,
    },
    artifacts: ["artifacts/task-6.json"],
  })), /DONE requires/);
  await assert.rejects(store.save(interruptedRecord({
    verification: {
      finalRevisionVerified: false,
      checks: [],
      independentReviewArtifactIds: [],
      correctionCycles: 3,
    },
  })), /Invalid durable task evidence/);
});

test("retention expires successful logs after seven days but failure logs require explicit clearing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-recovery-"));
  const store = new TaskRecordStore({ root });
  const successful = interruptedRecord({
    taskId: "task-success",
    identity: { ...identity, taskId: "task-success" },
    status: "DONE",
    actions: [
      { id: "prompt-1", kind: "PROMPT", phase: "INTENDED" },
      { id: "prompt-1", kind: "PROMPT", phase: "OBSERVED" },
    ],
    attempts: 1,
    approvals: [],
    verification: {
      finalRevisionVerified: true,
      checks: ["npm test"],
      independentReviewArtifactIds: ["review-standards", "review-spec"],
      correctionCycles: 0,
    },
    artifacts: ["artifacts/task-success.json"],
    finalCommit: "b".repeat(40),
    cleanup: { vmTerminated: true, successfulTabClosed: true },
    diagnostics: { outcome: "SUCCESS", logDirectory: "logs/task-success", completedAt: "2026-09-01T10:00:00.000Z" },
  });
  await store.save(successful);
  await mkdir(join(root, "logs", "task-success"), { recursive: true });
  await writeFile(join(root, "logs", "task-success", "run.log"), "success");
  await store.save(interruptedRecord());
  await mkdir(join(root, "diagnostics", "task-6"), { recursive: true });
  await writeFile(join(root, "diagnostics", "task-6", "failure.log"), "failure");

  const expired = await store.applyRetention(new Date("2026-09-08T10:00:00.000Z"));
  assert.deepEqual(expired, ["task-success"]);
  await assert.rejects(readFile(join(root, "logs", "task-success", "run.log")));
  assert.equal(await readFile(join(root, "diagnostics", "task-6", "failure.log"), "utf8"), "failure");
  await store.clearFailureDiagnostics(identity.taskId);
  await assert.rejects(readFile(join(root, "diagnostics", "task-6", "failure.log")));
});
