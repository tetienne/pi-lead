import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProposedChangeRuntimeFailure,
  runProposedChangeTask,
  type ProposedChangeRuntime,
  type ProposedChangeWorker,
} from "../src/proposed-change-task.ts";

function worker(): ProposedChangeWorker {
  return {
    taskId: "task-change",
    assignmentId: "assignment-change",
    workerId: "worker-change",
    vmId: "vm-change",
    tabId: "tab-change",
    paneId: "pane-change",
    piSessionId: "pi-change",
    baseCommit: "1111111111111111111111111111111111111111",
  };
}

test("a correlated validated proposal stops at the review-required human gate", async () => {
  const owned = worker();
  const calls: string[] = [];
  const runtime: ProposedChangeRuntime = {
    async launch(request) {
      calls.push("launch");
      assert.equal(request.namedBase, "main");
      assert.equal(request.privateWorkspace, true);
      assert.equal(request.focus, false);
      assert.deepEqual(request.hostMounts, []);
      assert.deepEqual(request.validationTasks, ["test", "typecheck"]);
      assert.deepEqual(request.allowedDependencyHosts, ["registry.npmjs.org"]);
      return owned;
    },
    async waitForResult() {
      calls.push("wait");
      return {
        ...owned,
        status: "proposed",
        proposedCommit: "2222222222222222222222222222222222222222",
        validations: [
          { task: "test", command: "mise run test", passed: true, exitCode: 0 },
          { task: "typecheck", command: "mise run typecheck", passed: true, exitCode: 0 },
        ],
      };
    },
    async collectResult() {
      calls.push("collect");
      return {
        artifactId: "artifact-change",
        files: [
          {
            path: "src/value.ts",
            status: "modified",
            oldMode: "100644",
            newMode: "100644",
            contentBase64: Buffer.from("export const value = 2;\n").toString("base64"),
            binary: false,
          },
        ],
      };
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: owned.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runProposedChangeTask(
    {
      taskId: owned.taskId,
      assignmentId: owned.assignmentId,
      instruction: "Change the exported value to 2.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test", "typecheck"],
      dependencyHosts: ["registry.npmjs.org"],
    },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "collect", "terminate", "close"]);
  assert.equal(summary.status, "REVIEW_REQUIRED");
  if (summary.status === "REVIEW_REQUIRED") {
    assert.equal(summary.humanGate, true);
    assert.equal(summary.hostCommitted, false);
    assert.equal(summary.published, false);
    assert.equal(summary.artifactId, "artifact-change");
    assert.equal(summary.vmTerminated, true);
    assert.equal(summary.files.length, 1);
  }
});

test("failed isolated validation blocks the proposal and retains stopped diagnostics", async () => {
  const owned = worker();
  let collected = false;
  const runtime: ProposedChangeRuntime = {
    async launch() {
      return owned;
    },
    async waitForResult() {
      return {
        ...owned,
        status: "proposed",
        proposedCommit: "2222222222222222222222222222222222222222",
        validations: [
          { task: "test", command: "mise run test", passed: false, exitCode: 1 },
        ],
      };
    },
    async collectResult() {
      collected = true;
      throw new Error("invalid proposals must not be collected");
    },
    async terminate() {
      return { vmId: owned.vmId, terminated: true };
    },
    async closeSuccessfulTab() {},
  };

  const summary = await runProposedChangeTask(
    {
      taskId: owned.taskId,
      assignmentId: owned.assignmentId,
      instruction: "Break the tests.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
    },
    runtime,
  );

  assert.equal(collected, false);
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "VALIDATION_FAILED");
    assert.equal(summary.diagnosticsRetained, true);
    assert.equal(summary.vmTerminated, true);
  }
});

test("a proposal forged for another base or worker is rejected before collection", async () => {
  const owned = worker();
  let collected = false;
  const runtime: ProposedChangeRuntime = {
    async launch() {
      return owned;
    },
    async waitForResult() {
      return {
        ...owned,
        workerId: "other-worker",
        baseCommit: "3333333333333333333333333333333333333333",
        status: "proposed",
        proposedCommit: "2222222222222222222222222222222222222222",
        validations: [],
      };
    },
    async collectResult() {
      collected = true;
      throw new Error("forged proposal must not be collected");
    },
    async terminate() {
      return { vmId: owned.vmId, terminated: true };
    },
    async closeSuccessfulTab() {},
  };

  const summary = await runProposedChangeTask(
    {
      taskId: owned.taskId,
      assignmentId: owned.assignmentId,
      instruction: "Change one file.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: [],
      dependencyHosts: [],
    },
    runtime,
  );

  assert.equal(collected, false);
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") assert.equal(summary.reason, "RESULT_IDENTITY_MISMATCH");
});

test("a denied dependency destination is preserved as a precise blocked outcome", async () => {
  const owned = worker();
  const runtime: ProposedChangeRuntime = {
    async launch() {
      return owned;
    },
    async waitForResult() {
      throw new ProposedChangeRuntimeFailure(
        "DEPENDENCY_DESTINATION_DENIED",
        "Dependency destination dl-cdn.alpinelinux.org is not explicitly allowed",
      );
    },
    async collectResult() {
      throw new Error("denied dependency must not be collected");
    },
    async terminate() {
      return { vmId: owned.vmId, terminated: true };
    },
    async closeSuccessfulTab() {},
  };

  const summary = await runProposedChangeTask(
    {
      taskId: owned.taskId,
      assignmentId: owned.assignmentId,
      instruction: "Change one file.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
    },
    runtime,
  );

  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "DEPENDENCY_DESTINATION_DENIED");
    assert.equal(
      summary.detail,
      "Dependency destination dl-cdn.alpinelinux.org is not explicitly allowed",
    );
    assert.equal(summary.vmTerminated, true);
  }
});
