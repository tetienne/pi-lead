import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runDebugTask,
  runStandaloneBranchReview,
  type DebugRuntime,
  type StandaloneBranchReviewRuntime,
} from "../src/debug-review-task.ts";
import type { CompleteLocalCodingDone } from "../src/review-fix-commit-task.ts";

const digest = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function completeTask(): CompleteLocalCodingDone {
  return {
    status: "DONE",
    taskId: "debug-13",
    proposal: {
      status: "REVIEW_REQUIRED",
      taskId: "debug-13",
      assignmentId: "debug-13:build:0",
      workerId: "builder",
      vmId: "vm-builder",
      tabId: "tab-builder",
      paneId: "pane-builder",
      piSessionId: "session-builder",
      baseCommit: commit("a"),
      proposedCommit: commit("b"),
      validations: [{ task: "test", command: "mise run test", passed: true, exitCode: 0 }],
      artifactId: digest("c"),
      files: [],
      humanGate: true,
      hostCommitted: false,
      published: false,
      vmTerminated: true,
    },
    reviews: [],
    reviewHistory: [],
    reviewCycles: 0,
    commit: {
      branchName: "pi-lead/task-debug-13",
      commit: commit("b"),
      committed: true,
      activeCheckoutPreserved: true,
    },
    published: false,
    specification: { source: "ticket.md", digest: digest("d"), contents: "ticket" },
    standards: { source: "AGENTS.md", digest: digest("e"), contents: "standards" },
  };
}

test("a debug task executes the symptom-specific failing loop before diagnosis, then verifies the reviewed fix", async () => {
  const calls: string[] = [];
  const runtime: DebugRuntime = {
    async executeFeedback(input) {
      calls.push(`${input.phase}:${input.command}`);
      return {
        taskId: input.task.taskId,
        feedbackId: input.feedbackId,
        command: input.command,
        passed: input.phase === "VERIFY",
        exitCode: input.phase === "VERIFY" ? 0 : 1,
        artifactId: digest(input.phase === "VERIFY" ? "c" : "a"),
        output: input.phase === "VERIFY" ? "fixed" : "seeded symptom",
      };
    },
    async diagnose(input) {
      calls.push(`diagnose:${input.reproduction.artifactId}`);
      assert.match(input.symptom, /saving/i);
      return { taskId: input.task.taskId, feedbackId: input.reproduction.feedbackId, artifactId: digest("b"), summary: "Null value reaches save." };
    },
    async implement(input) {
      calls.push(`implement:${input.diagnosis.artifactId}`);
      return completeTask();
    },
  };

  const result = await runDebugTask({
    task: {
      taskId: "debug-13",
      instruction: "Fix saving an empty title.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: digest("d"), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: digest("e"), contents: "standards" },
    },
    symptom: "Saving an empty title throws.",
    feedbackId: "empty-title-save",
    feedbackCommand: "mise run test -- empty-title-save",
  }, runtime);

  assert.equal(result.status, "DONE");
  assert.deepEqual(calls, [
    "REPRODUCE:mise run test -- empty-title-save",
    `diagnose:${digest("a")}`,
    `implement:${digest("b")}`,
    "VERIFY:mise run test -- empty-title-save",
  ]);
  if (result.status === "DONE") {
    assert.equal(result.reproduction.passed, false);
    assert.equal(result.verification.passed, true);
    assert.equal(result.implementation.commit.commit, commit("b"));
  }
});

test("a debug task blocks without diagnosing or changing code when the claimed symptom does not fail", async () => {
  let diagnosed = false;
  const runtime: DebugRuntime = {
    async executeFeedback(input) {
      return {
        taskId: input.task.taskId, feedbackId: input.feedbackId, command: input.command,
        passed: true, exitCode: 0, artifactId: digest("a"), output: "passes",
      };
    },
    async diagnose() { diagnosed = true; throw new Error("not reached"); },
    async implement() { throw new Error("not reached"); },
  };

  const result = await runDebugTask({
    task: {
      taskId: "debug-13", instruction: "Fix it.", repositoryPath: "/consumer", namedBase: "main",
      validationTasks: ["test"], dependencyHosts: [],
      specification: { source: "ticket.md", digest: digest("d"), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: digest("e"), contents: "standards" },
    },
    symptom: "It fails.", feedbackId: "repro", feedbackCommand: "mise run test -- repro",
  }, runtime);

  assert.deepEqual(result, {
    status: "BLOCKED",
    reason: "REPRODUCTION_NOT_FAILED",
    detail: "The symptom-specific reproduction did not fail",
    reproduction: {
      taskId: "debug-13", feedbackId: "repro", command: "mise run test -- repro",
      passed: true, exitCode: 0, artifactId: digest("a"), output: "passes",
    },
    diagnosticsRetained: true,
  });
  assert.equal(diagnosed, false);
});

test("a standalone branch review pins both independent reports without mutating or publishing", async () => {
  const calls: string[] = [];
  const runtime: StandaloneBranchReviewRuntime = {
    async review(input) {
      calls.push(input.axis);
      return {
        taskId: input.taskId,
        axis: input.axis,
        reviewerId: `reviewer-${input.axis}`,
        contextId: `context-${input.axis}`,
        comparisonSource: input.comparisonSource,
        specification: input.specification,
        standardsDigest: input.standards.digest,
        findings: [],
        readOnly: true,
        published: false,
      };
    },
  };
  const specification = { source: "spec.md", digest: digest("d"), contents: "specification" };
  const standards = { source: "AGENTS.md", digest: digest("e"), contents: "standards" };
  const result = await runStandaloneBranchReview({
    taskId: "review-13",
    baseCommit: commit("a"),
    proposedCommit: commit("b"),
    specification,
    standards,
  }, runtime);

  assert.equal(result.status, "DONE");
  assert.deepEqual(calls.sort(), ["SPEC", "STANDARDS"]);
  if (result.status === "DONE") {
    assert.equal(result.comparisonSource, `git:${commit("a")}...${commit("b")}`);
    assert.equal(result.reports.length, 2);
    assert.equal(result.reports.every((report) => report.readOnly && !report.published), true);
  }
});

test("a standalone branch review explicitly reports a missing spec while retaining its read-only Standards report", async () => {
  const runtime: StandaloneBranchReviewRuntime = {
    async review(input) {
      assert.equal(input.axis, "STANDARDS");
      return {
        taskId: input.taskId, axis: "STANDARDS", reviewerId: "reviewer", contextId: "context",
        comparisonSource: input.comparisonSource, standardsDigest: input.standards.digest,
        findings: [{ severity: "NON_BLOCKING", title: "Name", detail: "Rename this." }],
        readOnly: true, published: false,
      };
    },
  };
  const result = await runStandaloneBranchReview({
    taskId: "review-13", baseCommit: commit("a"), proposedCommit: commit("b"),
    standards: { source: "AGENTS.md", digest: digest("e"), contents: "standards" },
  }, runtime);

  assert.deepEqual(result, {
    status: "DONE",
    taskId: "review-13",
    comparisonSource: `git:${commit("a")}...${commit("b")}`,
    reports: [{
      taskId: "review-13", axis: "STANDARDS", reviewerId: "reviewer", contextId: "context",
      comparisonSource: `git:${commit("a")}...${commit("b")}`,
      standardsDigest: digest("e"),
      findings: [{ severity: "NON_BLOCKING", title: "Name", detail: "Rename this." }],
      readOnly: true, published: false,
    }],
    specification: { status: "MISSING_SPECIFICATION" },
    readOnly: true,
    published: false,
  });
});
