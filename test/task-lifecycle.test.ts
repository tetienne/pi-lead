import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FixtureLaunchFailure,
  runIsolatedFixture,
  type FixtureRuntime,
  type OwnedWorker,
} from "../src/task-lifecycle.ts";

test("cancellation is applied during launch and recorded as BLOCKED", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled before launch", "AbortError"));
  const runtime = {
    async launch(_request: unknown, signal?: AbortSignal) {
      assert.equal(signal?.aborted, true);
      throw new FixtureLaunchFailure("launch cancelled", true, true);
    },
  } as unknown as FixtureRuntime;

  const summary = await runIsolatedFixture(
    { taskId: "task-launch", assignmentId: "assignment-launch" },
    runtime,
    { signal: controller.signal },
  );

  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "CANCELLED",
    detail: "launch cancelled",
    taskId: "task-launch",
    assignmentId: "assignment-launch",
    diagnosticsRetained: true,
    resourcesStarted: false,
    vmTerminated: true,
  });
});

test("collects an attributable fixture result before terminating its VM and closing its background tab", async () => {
  const calls: string[] = [];
  const ownedWorker: OwnedWorker = {
    taskId: "task-1",
    assignmentId: "assignment-1",
    workerId: "worker-1",
    vmId: "vm-1",
    tabId: "tab-1",
    paneId: "pane-1",
  };

  const runtime: FixtureRuntime = {
    async launch(request) {
      assert.deepEqual(request.allowedHosts, []);
      assert.equal(request.allowWebSockets, false);
      assert.equal(request.focus, false);
      assert.equal(request.guestWorkspace, "/workspace");
      assert.deepEqual(request.hostMounts, []);
      assert.equal(request.inheritHostEnvironment, false);
      assert.equal(request.tabLabel, "PI Lead · isolated fixture");
      calls.push("launch");
      return ownedWorker;
    },
    async waitForResult(worker) {
      assert.equal(worker, ownedWorker);
      calls.push("wait");
      return { ...ownedWorker, output: "fixture complete" };
    },
    async collectResult(result) {
      calls.push("collect");
      return { output: result.output, artifactId: "artifact-1" };
    },
    async terminate(worker) {
      assert.equal(worker, ownedWorker);
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab(tabId) {
      assert.equal(tabId, "tab-1");
      calls.push("close");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: "task-1", assignmentId: "assignment-1" },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "collect", "terminate", "close"]);
  assert.deepEqual(summary, {
    status: "DONE",
    taskId: "task-1",
    assignmentId: "assignment-1",
    workerId: "worker-1",
    vmId: "vm-1",
    tabId: "tab-1",
    artifactId: "artifact-1",
    output: "fixture complete",
    vmTerminated: true,
  });
});

test("blocks a result from the wrong assignment while stopping execution and retaining diagnostics", async () => {
  const calls: string[] = [];
  const worker: OwnedWorker = {
    taskId: "task-current",
    assignmentId: "assignment-current",
    workerId: "worker-current",
    vmId: "vm-current",
    tabId: "tab-current",
    paneId: "pane-current",
  };
  const runtime: FixtureRuntime = {
    async launch() {
      calls.push("launch");
      return worker;
    },
    async waitForResult() {
      calls.push("wait");
      return {
        ...worker,
        assignmentId: "assignment-stale",
        output: "stale output",
      };
    },
    async collectResult() {
      calls.push("collect");
      throw new Error("a stale result must not be collected");
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: worker.taskId, assignmentId: worker.assignmentId },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "terminate"]);
  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "RESULT_IDENTITY_MISMATCH",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated: true,
  });
});

test("cancellation stops the owned VM and leaves the diagnostic tab visible", async () => {
  const calls: string[] = [];
  const worker: OwnedWorker = {
    taskId: "task-cancelled",
    assignmentId: "assignment-cancelled",
    workerId: "worker-cancelled",
    vmId: "vm-cancelled",
    tabId: "tab-cancelled",
    paneId: "pane-cancelled",
  };
  const controller = new AbortController();
  controller.abort(new DOMException("user cancelled", "AbortError"));

  const runtime: FixtureRuntime = {
    async launch() {
      calls.push("launch");
      return worker;
    },
    async waitForResult(_worker, signal) {
      calls.push("wait");
      assert.equal(signal?.aborted, true);
      throw signal?.reason;
    },
    async collectResult() {
      calls.push("collect");
      throw new Error("a cancelled result must not be collected");
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: worker.taskId, assignmentId: worker.assignmentId },
    runtime,
    { signal: controller.signal },
  );

  assert.deepEqual(calls, ["launch", "wait", "terminate"]);
  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "CANCELLED",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated: true,
  });
});

test("does not report DONE when VM termination cannot be confirmed", async () => {
  const calls: string[] = [];
  const worker: OwnedWorker = {
    taskId: "task-cleanup",
    assignmentId: "assignment-cleanup",
    workerId: "worker-cleanup",
    vmId: "vm-cleanup",
    tabId: "tab-cleanup",
    paneId: "pane-cleanup",
  };
  const runtime: FixtureRuntime = {
    async launch() {
      calls.push("launch");
      return worker;
    },
    async waitForResult() {
      calls.push("wait");
      return { ...worker, output: "fixture complete" };
    },
    async collectResult(result) {
      calls.push("collect");
      return { output: result.output, artifactId: "artifact-cleanup" };
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: false };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: worker.taskId, assignmentId: worker.assignmentId },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "collect", "terminate"]);
  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "CLEANUP_UNCONFIRMED",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated: false,
  });
});

test("records cleanup as unconfirmed when VM termination throws", async () => {
  const worker: OwnedWorker = {
    taskId: "task-cleanup-error",
    assignmentId: "assignment-cleanup-error",
    workerId: "worker-cleanup-error",
    vmId: "vm-cleanup-error",
    tabId: "tab-cleanup-error",
    paneId: "pane-cleanup-error",
  };
  const runtime: FixtureRuntime = {
    async launch() {
      return worker;
    },
    async waitForResult() {
      return { ...worker, output: "fixture complete" };
    },
    async collectResult(result) {
      return { output: result.output, artifactId: "artifact-cleanup-error" };
    },
    async terminate() {
      throw new Error("termination observation unavailable");
    },
    async closeSuccessfulTab() {
      throw new Error("a tab must remain visible when cleanup is unconfirmed");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: worker.taskId, assignmentId: worker.assignmentId },
    runtime,
  );

  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "CLEANUP_UNCONFIRMED",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated: false,
  });
});

test("a collection failure stops the VM and retains the diagnostic tab", async () => {
  const calls: string[] = [];
  const worker: OwnedWorker = {
    taskId: "task-collection",
    assignmentId: "assignment-collection",
    workerId: "worker-collection",
    vmId: "vm-collection",
    tabId: "tab-collection",
    paneId: "pane-collection",
  };
  const runtime: FixtureRuntime = {
    async launch() {
      calls.push("launch");
      return worker;
    },
    async waitForResult() {
      calls.push("wait");
      return { ...worker, output: "fixture complete" };
    },
    async collectResult() {
      calls.push("collect");
      throw new Error("artifact store unavailable");
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runIsolatedFixture(
    { taskId: worker.taskId, assignmentId: worker.assignmentId },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "collect", "terminate"]);
  assert.deepEqual(summary, {
    status: "BLOCKED",
    reason: "RUNTIME_FAILURE",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated: true,
  });
});
