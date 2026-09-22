import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { projectTaskStateRoot, recoverNativeInterruptedTasks } from "../src/native-task-recovery.ts";
import { TaskRecordStore, type DurableTaskRecord } from "../src/task-recovery.ts";

test("native recovery admits a project with no interrupted durable tasks without external probes", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-native-recovery-"));

  assert.deepEqual(await recoverNativeInterruptedTasks({ cwd: process.cwd(), stateRoot }), []);
});

test("native recovery is scoped to the consuming project", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-native-recovery-"));
  const projectA = join(stateRoot, "project-a");
  const projectB = join(stateRoot, "project-b");
  const store = new TaskRecordStore({ root: projectTaskStateRoot(projectA, stateRoot) });
  const identity = { taskId: "task-a", assignmentId: "build-a", workerId: "worker-a", vmId: "vm-a", piSessionId: "session-a", tabId: "tab-a", paneId: "pane-a" };
  await store.save({
    schemaVersion: 1, taskId: "task-a", status: "BUILD", identity,
    baseCommit: "a".repeat(40), branchName: "pi-lead/task-task-a",
    actions: [{ id: "prompt-a", kind: "PROMPT", phase: "INTENDED" }], attempts: 1, approvals: [],
    verification: { finalRevisionVerified: false, checks: [], independentReviewArtifactIds: [], correctionCycles: 0 },
    artifacts: [], cleanup: { vmTerminated: false, successfulTabClosed: false },
    diagnostics: { outcome: "FAILURE", logDirectory: "runs/task-a" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } satisfies DurableTaskRecord);

  assert.deepEqual(await recoverNativeInterruptedTasks({ cwd: projectB, stateRoot }), []);
});
