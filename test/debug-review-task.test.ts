import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  runDebugTask,
  runStandaloneBranchReview,
  type DebugRuntime,
  type StandaloneBranchReviewRuntime,
} from "../src/debug-review-task.ts";
import type { ReviewReport } from "../src/review-fix-commit-task.ts";
import type { ReviewRequiredSummary } from "../src/proposed-change-task.ts";

const digest = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);
const document = (source: string, contents: string) => ({
  source,
  contents,
  digest: createHash("sha256").update(contents, "utf8").digest("hex"),
});

function proposal(): ReviewRequiredSummary {
  return {
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
  };
}

function report(proposed: ReviewRequiredSummary, axis: "STANDARDS" | "SPEC"): ReviewReport {
  return {
    taskId: proposed.taskId,
    assignmentId: `review:${axis}`,
    axis,
    reviewerId: `reviewer-${axis}`,
    contextId: `context-${axis}`,
    baseCommit: proposed.baseCommit,
    proposedCommit: proposed.proposedCommit,
    artifactId: proposed.artifactId,
    reviewArtifactId: digest(axis === "STANDARDS" ? "d" : "e"),
    comparisonSource: `git:${proposed.baseCommit}..${proposed.proposedCommit}`,
    specSource: "ticket.md",
    specDigest: document("ticket.md", "ticket").digest,
    standardsDigest: document("AGENTS.md", "standards").digest,
    findings: [],
    vmTerminated: true,
    tabClosed: true,
  };
}

test("a debug task executes the symptom-specific failing loop before diagnosis, then verifies the reviewed fix", async () => {
  const calls: string[] = [];
  const built = proposal();
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
    async propose() {
      calls.push("propose");
      return built;
    },
    async review(input) {
      calls.push(`review:${input.axis}`);
      return report(input.proposal, input.axis);
    },
    async commit(input) {
      calls.push("commit");
      return { branchName: input.branchName, commit: input.proposal.proposedCommit, committed: true, activeCheckoutPreserved: true };
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
      specification: document("ticket.md", "ticket"),
      standards: document("AGENTS.md", "standards"),
    },
    symptom: "Saving an empty title throws.",
    feedbackId: "empty-title-save",
    feedbackCommand: "mise run test -- empty-title-save",
  }, runtime);

  assert.equal(result.status, "DONE");
  assert.deepEqual(calls, [
    "REPRODUCE:mise run test -- empty-title-save",
    `diagnose:${digest("a")}`,
    "propose",
    "review:STANDARDS",
    "review:SPEC",
    "commit",
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
    async propose() { throw new Error("not reached"); },
    async review() { throw new Error("not reached"); },
    async commit() { throw new Error("not reached"); },
  };

  const result = await runDebugTask({
    task: {
      taskId: "debug-13", instruction: "Fix it.", repositoryPath: "/consumer", namedBase: "main",
      validationTasks: ["test"], dependencyHosts: [],
      specification: document("ticket.md", "ticket"),
      standards: document("AGENTS.md", "standards"),
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
    async observeReadOnlyState() { return { worktreeDigest: digest("a"), refsDigest: digest("b") }; },
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
  const specification = document("spec.md", "specification");
  const standards = document("AGENTS.md", "standards");
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
    async observeReadOnlyState() { return { worktreeDigest: digest("a"), refsDigest: digest("b") }; },
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
    standards: document("AGENTS.md", "standards"),
  }, runtime);

  assert.deepEqual(result, {
    status: "DONE",
    taskId: "review-13",
    comparisonSource: `git:${commit("a")}...${commit("b")}`,
    reports: [{
      taskId: "review-13", axis: "STANDARDS", reviewerId: "reviewer", contextId: "context",
      comparisonSource: `git:${commit("a")}...${commit("b")}`,
      standardsDigest: document("AGENTS.md", "standards").digest,
      findings: [{ severity: "NON_BLOCKING", title: "Name", detail: "Rename this." }],
      readOnly: true, published: false,
    }],
    specification: { status: "MISSING_SPECIFICATION" },
    readOnly: true,
    published: false,
  });
});

test("a standalone review rejects a forged document pin before it can dispatch a reviewer", async () => {
  let reviewed = false;
  const runtime: StandaloneBranchReviewRuntime = {
    async observeReadOnlyState() { throw new Error("not reached"); },
    async review() { reviewed = true; throw new Error("not reached"); },
  };
  const result = await runStandaloneBranchReview({
    taskId: "review-13", baseCommit: commit("a"), proposedCommit: commit("b"),
    standards: { source: "AGENTS.md", contents: "standards", digest: digest("a") },
  }, runtime);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.status === "BLOCKED" && result.reason, "INVALID_REVIEW_CONTEXT");
  assert.equal(reviewed, false);
});

test("a standalone review blocks if its supposedly read-only workers changed worktree or refs", async () => {
  let observations = 0;
  const standards = document("AGENTS.md", "standards");
  const runtime: StandaloneBranchReviewRuntime = {
    async observeReadOnlyState() {
      observations++;
      return { worktreeDigest: digest(observations === 1 ? "a" : "c"), refsDigest: digest("b") };
    },
    async review(input) {
      return {
        taskId: input.taskId, axis: input.axis, reviewerId: "reviewer", contextId: "context",
        comparisonSource: input.comparisonSource, standardsDigest: input.standards.digest,
        findings: [], readOnly: true, published: false,
      };
    },
  };
  const result = await runStandaloneBranchReview({
    taskId: "review-13", baseCommit: commit("a"), proposedCommit: commit("b"), standards,
  }, runtime);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.status === "BLOCKED" && result.reason, "REVIEW_EVIDENCE_INVALID");
});
