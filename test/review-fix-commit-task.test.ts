import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runReviewFixCommitTask,
  type ReviewFixCommitRuntime,
  type ReviewReport,
} from "../src/review-fix-commit-task.ts";
import type { ReviewRequiredSummary } from "../src/proposed-change-task.ts";

function proposal(revision: string, assignmentId = "task-4:build:0"): ReviewRequiredSummary {
  return {
    status: "REVIEW_REQUIRED",
    taskId: "task-4",
    assignmentId,
    workerId: `worker-${revision}`,
    vmId: `vm-${revision}`,
    tabId: `tab-${revision}`,
    paneId: `pane-${revision}`,
    piSessionId: `session-${revision}`,
    baseCommit: "a".repeat(40),
    proposedCommit: revision.repeat(40).slice(0, 40),
    validations: [{ task: "test", command: "mise run test", passed: true, exitCode: 0 }],
    artifactId: `artifact-${revision}`,
    files: [],
    humanGate: true,
    hostCommitted: false,
    published: false,
    vmTerminated: true,
  };
}

function report(
  proposalSummary: ReviewRequiredSummary,
  axis: "STANDARDS" | "SPEC",
  findings: ReviewReport["findings"],
): ReviewReport {
  return {
    taskId: proposalSummary.taskId,
    assignmentId: `${proposalSummary.assignmentId}:${axis.toLowerCase()}`,
    axis,
    reviewerId: `reviewer-${axis}`,
    contextId: `context-${axis}`,
    baseCommit: proposalSummary.baseCommit,
    proposedCommit: proposalSummary.proposedCommit,
    artifactId: proposalSummary.artifactId,
    reviewArtifactId: "e".repeat(64),
    comparisonSource: `git:${proposalSummary.baseCommit}..${proposalSummary.proposedCommit}`,
    specSource: "ticket.md",
    specDigest: "f".repeat(64),
    standardsDigest: "d".repeat(64),
    findings,
    vmTerminated: true,
    tabClosed: true,
  };
}

test("a clean independent Standards and Spec review delivers the exact validated proposal on a task branch", async () => {
  const initial = proposal("b");
  const calls: string[] = [];
  const runtime: ReviewFixCommitRuntime = {
    async propose() {
      calls.push("propose");
      return initial;
    },
    async review(input) {
      calls.push(`review:${input.axis}:${input.proposal.proposedCommit}`);
      return report(input.proposal, input.axis, []);
    },
    async commit(input) {
      calls.push(`commit:${input.branchName}`);
      assert.equal(input.proposal.proposedCommit, initial.proposedCommit);
      return {
        branchName: input.branchName,
        commit: initial.proposedCommit,
        committed: true,
        activeCheckoutPreserved: true,
      };
    },
  };

  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );

  assert.equal(summary.status, "DONE");
  if (summary.status === "DONE") {
    assert.equal(summary.commit.commit, initial.proposedCommit);
    assert.equal(summary.reviewCycles, 0);
    assert.equal(summary.reviews.length, 2);
  }
  assert.deepEqual(calls, [
    "propose",
    `review:STANDARDS:${initial.proposedCommit}`,
    `review:SPEC:${initial.proposedCommit}`,
    "commit:pi-lead/task-task-4",
  ]);
});

test("a reviewed local commit is published only through the exact task-branch publication boundary", async () => {
  const initial = proposal("b");
  let published = false;
  const runtime: ReviewFixCommitRuntime = {
    async propose() { return initial; },
    async review(input) { return report(input.proposal, input.axis, []); },
    async commit(input) {
      return { branchName: input.branchName, commit: input.proposal.proposedCommit, committed: true, activeCheckoutPreserved: true };
    },
    async publish(input) {
      published = true;
      assert.equal(input.commit.branchName, "pi-lead/task-task-4");
      assert.equal(input.commit.commit, initial.proposedCommit);
      return {
        status: "PUBLISHED",
        intent: {
          operation: "PUSH_TASK_BRANCH", remoteName: "publish",
          sourceRef: "refs/heads/pi-lead/task-task-4", destinationRef: "refs/heads/pi-lead/task-task-4",
          commit: initial.proposedCommit,
        },
        observedCommit: initial.proposedCommit,
      };
    },
  };
  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4", instruction: "Change the value.", repositoryPath: "/consumer", namedBase: "main",
      validationTasks: ["test"], dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    }, runtime,
  );
  assert.equal(summary.status, "DONE");
  assert.equal(summary.status === "DONE" && summary.published, true);
  assert.equal(published, true);
});

test("an uncertain publication blocks completion while retaining the reviewed local commit", async () => {
  const initial = proposal("b");
  const runtime: ReviewFixCommitRuntime = {
    async propose() { return initial; },
    async review(input) { return report(input.proposal, input.axis, []); },
    async commit(input) {
      return { branchName: input.branchName, commit: input.proposal.proposedCommit, committed: true, activeCheckoutPreserved: true };
    },
    async publish(input) {
      return {
        status: "UNCERTAIN",
        intent: {
          operation: "PUSH_TASK_BRANCH", remoteName: "publish",
          sourceRef: `refs/heads/${input.commit.branchName}`, destinationRef: `refs/heads/${input.commit.branchName}`,
          commit: input.commit.commit,
        },
        detail: "Push result could not be reconciled",
      };
    },
  };
  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4", instruction: "Change the value.", repositoryPath: "/consumer", namedBase: "main",
      validationTasks: ["test"], dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    }, runtime,
  );
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "PUBLICATION_BLOCKED");
    assert.equal(summary.commit?.commit, initial.proposedCommit);
    assert.equal(summary.publication?.status, "UNCERTAIN");
  }
});

test("a review correction replaces stale evidence and revalidates before final independent review", async () => {
  const initial = proposal("b");
  const corrected = proposal("c", "task-4:build:1");
  let proposals = 0;
  const reviewRevisions: string[] = [];
  const runtime: ReviewFixCommitRuntime = {
    async propose(input) {
      proposals++;
      if (proposals === 2) {
        assert.match(input.instruction, /Correct the independently reviewed findings/);
        assert.match(input.instruction, /missing boundary validation/);
      }
      return proposals === 1 ? initial : corrected;
    },
    async review(input) {
      reviewRevisions.push(`${input.axis}:${input.proposal.proposedCommit}`);
      const findings =
        input.proposal.proposedCommit === initial.proposedCommit && input.axis === "SPEC"
          ? [{ severity: "BLOCKING" as const, title: "missing boundary validation", detail: "Validate input." }]
          : [];
      return report(input.proposal, input.axis, findings);
    },
    async commit(input) {
      return {
        branchName: input.branchName,
        commit: input.proposal.proposedCommit,
        committed: true,
        activeCheckoutPreserved: true,
      };
    },
  };

  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );

  assert.equal(summary.status, "DONE");
  if (summary.status === "DONE") {
    assert.equal(summary.proposal.proposedCommit, corrected.proposedCommit);
    assert.equal(summary.reviewCycles, 1);
    assert.equal(summary.reviews.every((entry) => entry.proposedCommit === corrected.proposedCommit), true);
    assert.deepEqual(
      summary.reviewHistory.map((round) => round.reviews.map((entry) => entry.proposedCommit)),
      [
        [initial.proposedCommit, initial.proposedCommit],
        [corrected.proposedCommit, corrected.proposedCommit],
      ],
    );
  }
  assert.deepEqual(reviewRevisions, [
    `STANDARDS:${initial.proposedCommit}`,
    `SPEC:${initial.proposedCommit}`,
    `STANDARDS:${corrected.proposedCommit}`,
    `SPEC:${corrected.proposedCommit}`,
  ]);
});

test("a third unresolved review blocks with both bound and diagnostic reports retained", async () => {
  const proposals = [proposal("b"), proposal("c", "task-4:build:1"), proposal("d", "task-4:build:2")];
  let proposalIndex = 0;
  const runtime: ReviewFixCommitRuntime = {
    async propose() {
      return proposals[proposalIndex++] ?? proposals[2]!;
    },
    async review(input) {
      return report(input.proposal, input.axis, [
        { severity: "BLOCKING", title: `${input.axis} finding`, detail: "Still unresolved." },
      ]);
    },
    async commit() {
      throw new Error("an unresolved review must not be committed");
    },
  };

  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );

  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "REVIEW_LIMIT_REACHED");
    assert.equal(summary.reviewCycles, 2);
    assert.equal(summary.diagnosticsRetained, true);
    assert.equal(summary.reviews.length, 2);
  }
  assert.equal(proposalIndex, 3);
});

test("review evidence from a shared context or stale revision cannot authorize a commit", async () => {
  const initial = proposal("b");
  const runtime: ReviewFixCommitRuntime = {
    async propose() {
      return initial;
    },
    async review(input) {
      const result = report(input.proposal, input.axis, []);
      return { ...result, contextId: "shared-context", proposedCommit: "c".repeat(40) };
    },
    async commit() {
      throw new Error("invalid review evidence must not commit");
    },
  };

  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );

  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") assert.equal(summary.reason, "REVIEW_EVIDENCE_INVALID");
});

test("a proposal without the exact final required checks cannot reach independent review", async () => {
  let reviewed = false;
  const runtime: ReviewFixCommitRuntime = {
    async propose() {
      return { ...proposal("b"), validations: [] };
    },
    async review() {
      reviewed = true;
      throw new Error("invalid proposal must not be reviewed");
    },
    async commit() {
      throw new Error("invalid proposal must not commit");
    },
  };
  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") assert.equal(summary.reason, "BUILD_BLOCKED");
  assert.equal(reviewed, false);
});

test("a stale proposal for another build assignment cannot reach review", async () => {
  let reviewed = false;
  const runtime: ReviewFixCommitRuntime = {
    async propose() {
      return proposal("b", "task-4:build:stale");
    },
    async review() {
      reviewed = true;
      throw new Error("stale proposal must not be reviewed");
    },
    async commit() {
      throw new Error("stale proposal must not commit");
    },
  };
  const summary = await runReviewFixCommitTask(
    {
      taskId: "task-4",
      instruction: "Change the value.",
      repositoryPath: "/consumer",
      namedBase: "main",
      validationTasks: ["test"],
      dependencyHosts: [],
      specification: { source: "ticket.md", digest: "f".repeat(64), contents: "ticket" },
      standards: { source: "AGENTS.md", digest: "d".repeat(64), contents: "standards" },
    },
    runtime,
  );
  assert.equal(summary.status, "BLOCKED");
  assert.equal(reviewed, false);
});
