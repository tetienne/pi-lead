import type {
  ProposedChangeRequest,
  ProposedChangeSummary,
  ReviewRequiredSummary,
} from "./proposed-change-task.ts";
import type { PublicationOutcome } from "./git-publication.ts";
import type { PinnedReviewDocument } from "./review-context.ts";

export type ReviewAxis = "STANDARDS" | "SPEC";

export type ReviewFinding = {
  severity: "BLOCKING" | "NON_BLOCKING";
  title: string;
  detail: string;
};

export type ReviewReport = {
  taskId: string;
  assignmentId: string;
  axis: ReviewAxis;
  reviewerId: string;
  contextId: string;
  baseCommit: string;
  proposedCommit: string;
  artifactId: string;
  reviewArtifactId: string;
  comparisonSource: string;
  specSource: string;
  specDigest: string;
  standardsDigest: string;
  findings: readonly ReviewFinding[];
  vmTerminated: true;
  tabClosed: true;
};

export type CompleteLocalCodingRequest = Omit<
  ProposedChangeRequest,
  "assignmentId"
> & {
  specification: PinnedReviewDocument;
  standards: PinnedReviewDocument;
};

export type ReviewInput = {
  task: CompleteLocalCodingRequest;
  proposal: ReviewRequiredSummary;
  axis: ReviewAxis;
  comparisonSource: string;
  specification: PinnedReviewDocument;
  standards: PinnedReviewDocument;
};

export type CommitEvidence = {
  branchName: string;
  commit: string;
  committed: true;
  activeCheckoutPreserved: true;
};

export interface ReviewFixCommitRuntime {
  propose(request: ProposedChangeRequest, signal?: AbortSignal): Promise<ProposedChangeSummary>;
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewReport>;
  commit(
    input: { proposal: ReviewRequiredSummary; branchName: string },
    signal?: AbortSignal,
  ): Promise<CommitEvidence>;
  publish?(
    input: { proposal: ReviewRequiredSummary; commit: CommitEvidence },
    signal?: AbortSignal,
  ): Promise<PublicationOutcome>;
}

export type CompleteLocalCodingDone = {
  status: "DONE";
  taskId: string;
  proposal: ReviewRequiredSummary;
  reviews: readonly ReviewReport[];
  reviewHistory: readonly { correctionCycle: number; reviews: readonly ReviewReport[] }[];
  reviewCycles: number;
  commit: CommitEvidence;
  published: boolean;
  publication?: PublicationOutcome;
  specification: PinnedReviewDocument;
  standards: PinnedReviewDocument;
};

export type CompleteLocalCodingBlocked = {
  status: "BLOCKED";
  taskId: string;
  reason:
    | "BUILD_BLOCKED"
    | "COMMIT_FAILED"
    | "PUBLICATION_BLOCKED"
    | "REVIEW_EVIDENCE_INVALID"
    | "REVIEW_FAILED"
    | "REVIEW_LIMIT_REACHED";
  detail: string;
  proposal?: ReviewRequiredSummary;
  commit?: CommitEvidence;
  publication?: PublicationOutcome;
  reviews: readonly ReviewReport[];
  reviewHistory: readonly { correctionCycle: number; reviews: readonly ReviewReport[] }[];
  reviewCycles: number;
  diagnosticsRetained: true;
  specification: PinnedReviewDocument;
  standards: PinnedReviewDocument;
};

export type CompleteLocalCodingSummary = CompleteLocalCodingDone | CompleteLocalCodingBlocked;

const REVIEW_AXES: readonly ReviewAxis[] = ["STANDARDS", "SPEC"];
const MAX_REVIEW_FIX_CYCLES = 2;

function taskBranchName(taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new Error("Task ID cannot be used in a task branch name");
  }
  return `pi-lead/task-${taskId}`;
}

function comparisonSource(proposal: ReviewRequiredSummary): string {
  return `git:${proposal.baseCommit}..${proposal.proposedCommit}`;
}

function validatedProposal(
  expectedChecks: readonly string[],
  request: ProposedChangeRequest,
  summary: ProposedChangeSummary,
): ReviewRequiredSummary | undefined {
  if (
    summary.status !== "REVIEW_REQUIRED" ||
    summary.taskId !== request.taskId ||
    summary.assignmentId !== request.assignmentId
  ) return undefined;
  if (
    !summary.vmTerminated ||
    summary.validations.length !== expectedChecks.length ||
    !summary.validations.every(
      (validation, index) =>
        validation.task === expectedChecks[index] &&
        validation.command === `mise run ${validation.task}` &&
        validation.passed &&
        validation.exitCode === 0,
    )
  ) {
    return undefined;
  }
  return summary;
}

function reportMatches(
  report: ReviewReport,
  input: ReviewInput,
  otherReport: ReviewReport | undefined,
): boolean {
  return (
    report.taskId === input.task.taskId &&
    report.axis === input.axis &&
    report.baseCommit === input.proposal.baseCommit &&
    report.proposedCommit === input.proposal.proposedCommit &&
    report.artifactId === input.proposal.artifactId &&
    /^[0-9a-f]{64}$/.test(report.reviewArtifactId) &&
    report.comparisonSource === input.comparisonSource &&
    report.specSource === input.specification.source &&
    report.specDigest === input.specification.digest &&
    report.standardsDigest === input.standards.digest &&
    report.reviewerId.length > 0 &&
    report.contextId.length > 0 &&
    report.vmTerminated &&
    report.tabClosed &&
    report.findings.every(
      (finding) =>
        (finding.severity === "BLOCKING" || finding.severity === "NON_BLOCKING") &&
        finding.title.trim().length > 0 &&
        finding.detail.trim().length > 0,
    ) &&
    (!otherReport ||
      (report.reviewerId !== otherReport.reviewerId && report.contextId !== otherReport.contextId))
  );
}

function correctionInstruction(
  task: CompleteLocalCodingRequest,
  reports: readonly ReviewReport[],
): string {
  const findings = reports
    .flatMap((report) =>
      report.findings
        .filter((finding) => finding.severity === "BLOCKING")
        .map((finding) => `[${report.axis}] ${finding.title}: ${finding.detail}`),
    )
    .join("\n");
  return [
    task.instruction,
    "",
    "Correct the independently reviewed findings below. Reproduce the requested change and all corrections from the named base; do not commit.",
    findings,
  ].join("\n");
}

function blocked(
  taskId: string,
  reason: CompleteLocalCodingBlocked["reason"],
  detail: string,
  reviewCycles: number,
  reviews: readonly ReviewReport[],
  reviewHistory: readonly { correctionCycle: number; reviews: readonly ReviewReport[] }[],
  documents: Pick<CompleteLocalCodingRequest, "specification" | "standards">,
  proposal?: ReviewRequiredSummary,
  commit?: CommitEvidence,
  publication?: PublicationOutcome,
): CompleteLocalCodingBlocked {
  return {
    status: "BLOCKED",
    taskId,
    reason,
    detail,
    ...(proposal ? { proposal } : {}),
    ...(commit ? { commit } : {}),
    ...(publication ? { publication } : {}),
    reviews,
    reviewHistory,
    reviewCycles,
    diagnosticsRetained: true,
    ...documents,
  };
}

export async function runReviewFixCommitTask(
  task: CompleteLocalCodingRequest,
  runtime: ReviewFixCommitRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<CompleteLocalCodingSummary> {
  let reviewCycles = 0;
  const reviewHistory: Array<{ correctionCycle: number; reviews: readonly ReviewReport[] }> = [];
  let currentRequest: ProposedChangeRequest = {
    ...task,
    assignmentId: `${task.taskId}:build:0`,
  };
  let proposalResult: ProposedChangeSummary;
  try {
    proposalResult = await runtime.propose(currentRequest, options.signal);
  } catch (error) {
    return blocked(
      task.taskId,
      "BUILD_BLOCKED",
      error instanceof Error ? error.message : String(error),
      reviewCycles,
      [],
      reviewHistory,
      task,
    );
  }
  let proposal = validatedProposal(task.validationTasks, currentRequest, proposalResult);
  if (!proposal) {
    return blocked(
      task.taskId,
      "BUILD_BLOCKED",
      proposalResult.status === "BLOCKED" ? proposalResult.detail ?? proposalResult.reason : "Proposal lacks final validation/cleanup evidence",
      reviewCycles,
      [],
      reviewHistory,
      task,
    );
  }

  while (true) {
    const reviewedProposal = proposal;
    if (!reviewedProposal) {
      return blocked(task.taskId, "BUILD_BLOCKED", "Proposal is unavailable for review", reviewCycles, [], reviewHistory, task);
    }
    const source = comparisonSource(reviewedProposal);
    const reviewResults = await Promise.allSettled(
        REVIEW_AXES.map((axis) =>
          runtime.review(
            {
              task,
              proposal: reviewedProposal,
              axis,
              comparisonSource: source,
              specification: task.specification,
              standards: task.standards,
            },
            options.signal,
          ),
        ),
      );
    const failedReview = reviewResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedReview) {
      return blocked(
        task.taskId,
        "REVIEW_FAILED",
        failedReview.reason instanceof Error ? failedReview.reason.message : String(failedReview.reason),
        reviewCycles,
        [],
        reviewHistory,
        task,
        reviewedProposal,
      );
    }
    const reviews = reviewResults.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Unreachable review result");
      return result.value;
    });
    const standards = reviews.find((review) => review.axis === "STANDARDS");
    const spec = reviews.find((review) => review.axis === "SPEC");
    if (
      reviews.length !== REVIEW_AXES.length ||
      !standards ||
      !spec ||
      !reportMatches(standards, { task, proposal: reviewedProposal, axis: "STANDARDS", comparisonSource: source, specification: task.specification, standards: task.standards }, spec) ||
      !reportMatches(spec, { task, proposal: reviewedProposal, axis: "SPEC", comparisonSource: source, specification: task.specification, standards: task.standards }, standards)
    ) {
      return blocked(
        task.taskId,
        "REVIEW_EVIDENCE_INVALID",
        "Independent Standards and Spec reports must both cover the exact final proposal and separate review contexts",
        reviewCycles,
        reviews,
        reviewHistory,
        task,
        reviewedProposal,
      );
    }
    reviewHistory.push({ correctionCycle: reviewCycles, reviews });
    const blockers = reviews.some((review) =>
      review.findings.some((finding) => finding.severity === "BLOCKING"),
    );
    if (!blockers) {
      try {
        const commit = await runtime.commit(
          { proposal: reviewedProposal, branchName: taskBranchName(task.taskId) },
          options.signal,
        );
        if (
          !commit.committed ||
          !commit.activeCheckoutPreserved ||
          commit.commit !== reviewedProposal.proposedCommit ||
          commit.branchName !== taskBranchName(task.taskId)
        ) {
          return blocked(
            task.taskId,
            "COMMIT_FAILED",
            "Commit evidence did not match the final reviewed proposal and task branch",
            reviewCycles,
            reviews,
            reviewHistory,
            task,
            reviewedProposal,
          );
        }
        if (runtime.publish) {
          let publication: PublicationOutcome;
          try {
            publication = await runtime.publish({ proposal: reviewedProposal, commit }, options.signal);
          } catch (error) {
            return blocked(
              task.taskId,
              "PUBLICATION_BLOCKED",
              error instanceof Error ? error.message : String(error),
              reviewCycles,
              reviews,
              reviewHistory,
              task,
              reviewedProposal,
              commit,
            );
          }
          if (publication.status !== "PUBLISHED" && publication.status !== "ALREADY_PUBLISHED") {
            return blocked(
              task.taskId,
              "PUBLICATION_BLOCKED",
              publication.detail ?? `Publication ended ${publication.status}`,
              reviewCycles,
              reviews,
              reviewHistory,
              task,
              reviewedProposal,
              commit,
              publication,
            );
          }
          return {
            status: "DONE",
            taskId: task.taskId,
            proposal: reviewedProposal,
            reviews,
            reviewHistory,
            reviewCycles,
            commit,
            published: true,
            publication,
            specification: task.specification,
            standards: task.standards,
          };
        }
        return {
          status: "DONE",
          taskId: task.taskId,
          proposal: reviewedProposal,
          reviews,
          reviewHistory,
          reviewCycles,
          commit,
          published: false,
          specification: task.specification,
          standards: task.standards,
        };
      } catch (error) {
        return blocked(
          task.taskId,
          "COMMIT_FAILED",
          error instanceof Error ? error.message : String(error),
          reviewCycles,
          reviews,
          reviewHistory,
          task,
          reviewedProposal,
        );
      }
    }
    if (reviewCycles >= MAX_REVIEW_FIX_CYCLES) {
      return blocked(
        task.taskId,
        "REVIEW_LIMIT_REACHED",
        `Independent review still has blocking findings after ${MAX_REVIEW_FIX_CYCLES} correction cycles`,
        reviewCycles,
        reviews,
        reviewHistory,
        task,
        reviewedProposal,
      );
    }
    reviewCycles++;
    currentRequest = {
      ...task,
      assignmentId: `${task.taskId}:build:${reviewCycles}`,
      instruction: correctionInstruction(task, reviews),
    };
    try {
      proposalResult = await runtime.propose(currentRequest, options.signal);
    } catch (error) {
      return blocked(
        task.taskId,
        "BUILD_BLOCKED",
        error instanceof Error ? error.message : String(error),
        reviewCycles,
        reviews,
        reviewHistory,
        task,
        reviewedProposal,
      );
    }
    proposal = validatedProposal(task.validationTasks, currentRequest, proposalResult);
    if (!proposal) {
      return blocked(
        task.taskId,
        "BUILD_BLOCKED",
        proposalResult.status === "BLOCKED" ? proposalResult.detail ?? proposalResult.reason : "Correction lacks final validation/cleanup evidence",
        reviewCycles,
        reviews,
        reviewHistory,
        task,
      );
    }
  }
}
