import { createHash } from "node:crypto";

import { pinGitBranchComparison } from "./git-proposal.ts";
import type { PinnedReviewDocument } from "./review-context.ts";
import type {
  CompleteLocalCodingDone,
  CompleteLocalCodingRequest,
  CompleteLocalCodingSummary,
  ReviewAxis,
  ReviewFinding,
  ReviewFixCommitRuntime,
} from "./review-fix-commit-task.ts";
import { runReviewFixCommitTask } from "./review-fix-commit-task.ts";

const DIGEST = /^[0-9a-f]{64}$/;

export type FeedbackPhase = "REPRODUCE" | "VERIFY";

export type FeedbackEvidence = {
  taskId: string;
  feedbackId: string;
  command: string;
  passed: boolean;
  exitCode: number;
  artifactId: string;
  output: string;
};

export type DiagnosisEvidence = {
  taskId: string;
  feedbackId: string;
  artifactId: string;
  summary: string;
};

export type DebugTaskRequest = {
  task: CompleteLocalCodingRequest;
  symptom: string;
  feedbackId: string;
  feedbackCommand: string;
};

export interface DebugRuntime extends ReviewFixCommitRuntime {
  executeFeedback(input: {
    task: CompleteLocalCodingRequest;
    symptom: string;
    feedbackId: string;
    command: string;
    phase: FeedbackPhase;
  }, signal?: AbortSignal): Promise<FeedbackEvidence>;
  diagnose(input: {
    task: CompleteLocalCodingRequest;
    symptom: string;
    reproduction: FeedbackEvidence;
  }, signal?: AbortSignal): Promise<DiagnosisEvidence>;
}

export type DebugTaskDone = {
  status: "DONE";
  taskId: string;
  reproduction: FeedbackEvidence;
  diagnosis: DiagnosisEvidence;
  implementation: CompleteLocalCodingDone;
  verification: FeedbackEvidence;
};

export type DebugTaskBlocked = {
  status: "BLOCKED";
  reason:
    | "DIAGNOSIS_FAILED"
    | "IMPLEMENTATION_BLOCKED"
    | "INVALID_EVIDENCE"
    | "REPRODUCTION_NOT_FAILED"
    | "VERIFICATION_FAILED";
  detail: string;
  reproduction?: FeedbackEvidence;
  diagnosis?: DiagnosisEvidence;
  implementation?: CompleteLocalCodingSummary;
  verification?: FeedbackEvidence;
  diagnosticsRetained: true;
};

export type DebugTaskSummary = DebugTaskDone | DebugTaskBlocked;

function validFeedback(
  evidence: FeedbackEvidence,
  input: Pick<DebugTaskRequest, "task" | "feedbackId" | "feedbackCommand">,
): boolean {
  return (
    evidence.taskId === input.task.taskId &&
    evidence.feedbackId === input.feedbackId &&
    evidence.command === input.feedbackCommand &&
    typeof evidence.passed === "boolean" &&
    Number.isSafeInteger(evidence.exitCode) &&
    evidence.exitCode >= 0 &&
    DIGEST.test(evidence.artifactId) &&
    evidence.output.trim().length > 0
  );
}

function validDiagnosis(evidence: DiagnosisEvidence, request: DebugTaskRequest): boolean {
  return (
    evidence.taskId === request.task.taskId &&
    evidence.feedbackId === request.feedbackId &&
    DIGEST.test(evidence.artifactId) &&
    evidence.summary.trim().length > 0
  );
}

function blocked(
  reason: DebugTaskBlocked["reason"],
  detail: string,
  evidence: Omit<DebugTaskBlocked, "status" | "reason" | "detail" | "diagnosticsRetained">,
): DebugTaskBlocked {
  return { status: "BLOCKED", reason, detail, ...evidence, diagnosticsRetained: true };
}

export async function runDebugTask(
  request: DebugTaskRequest,
  runtime: DebugRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<DebugTaskSummary> {
  if (
    !request.symptom.trim() ||
    !request.feedbackId.trim() ||
    !request.feedbackCommand.trim()
  ) {
    return blocked("INVALID_EVIDENCE", "Debug requests require a symptom, feedback ID, and feedback command", {});
  }

  let reproduction: FeedbackEvidence;
  try {
    reproduction = await runtime.executeFeedback({
      task: request.task,
      symptom: request.symptom,
      feedbackId: request.feedbackId,
      command: request.feedbackCommand,
      phase: "REPRODUCE",
    }, options.signal);
  } catch (error) {
    return blocked("REPRODUCTION_NOT_FAILED", error instanceof Error ? error.message : String(error), {});
  }
  if (!validFeedback(reproduction, request)) {
    return blocked("INVALID_EVIDENCE", "Reproduction evidence is not attributable to the requested symptom", { reproduction });
  }
  if (reproduction.passed || reproduction.exitCode === 0) {
    return blocked("REPRODUCTION_NOT_FAILED", "The symptom-specific reproduction did not fail", { reproduction });
  }

  let diagnosis: DiagnosisEvidence;
  try {
    diagnosis = await runtime.diagnose({ task: request.task, symptom: request.symptom, reproduction }, options.signal);
  } catch (error) {
    return blocked("DIAGNOSIS_FAILED", error instanceof Error ? error.message : String(error), { reproduction });
  }
  if (!validDiagnosis(diagnosis, request)) {
    return blocked("INVALID_EVIDENCE", "Diagnosis evidence is not attributable to the reproduced symptom", { reproduction, diagnosis });
  }

  let implementation: CompleteLocalCodingSummary;
  try {
    implementation = await runReviewFixCommitTask(
      {
        ...request.task,
        instruction: [
          request.task.instruction,
          "",
          "Diagnose and correct the reproduced symptom using this attributable diagnosis evidence:",
          diagnosis.summary,
        ].join("\n"),
      },
      runtime,
      options,
    );
  } catch (error) {
    return blocked("IMPLEMENTATION_BLOCKED", error instanceof Error ? error.message : String(error), { reproduction, diagnosis });
  }
  if (implementation.status !== "DONE") {
    return blocked("IMPLEMENTATION_BLOCKED", implementation.detail, { reproduction, diagnosis, implementation });
  }
  if (implementation.taskId !== request.task.taskId || implementation.reviewCycles > 2) {
    return blocked("INVALID_EVIDENCE", "The fix did not preserve the bounded reviewed implementation evidence", { reproduction, diagnosis, implementation });
  }

  let verification: FeedbackEvidence;
  try {
    verification = await runtime.executeFeedback({
      task: request.task,
      symptom: request.symptom,
      feedbackId: request.feedbackId,
      command: request.feedbackCommand,
      phase: "VERIFY",
    }, options.signal);
  } catch (error) {
    return blocked("VERIFICATION_FAILED", error instanceof Error ? error.message : String(error), { reproduction, diagnosis, implementation });
  }
  if (!validFeedback(verification, request)) {
    return blocked("INVALID_EVIDENCE", "Verification evidence is not attributable to the reproduced symptom", { reproduction, diagnosis, implementation, verification });
  }
  if (!verification.passed || verification.exitCode !== 0) {
    return blocked("VERIFICATION_FAILED", "The fixed symptom-specific feedback loop did not pass", { reproduction, diagnosis, implementation, verification });
  }
  return { status: "DONE", taskId: request.task.taskId, reproduction, diagnosis, implementation, verification };
}

export type StandaloneBranchReviewRequest = {
  taskId: string;
  repositoryPath: string;
  namedBase: string;
  reviewBranch: string;
  specification?: PinnedReviewDocument;
  standards: PinnedReviewDocument;
};

export type StandaloneBranchReviewReport = {
  taskId: string;
  axis: ReviewAxis;
  reviewerId: string;
  contextId: string;
  comparisonSource: string;
  specification?: PinnedReviewDocument;
  standardsDigest: string;
  findings: readonly ReviewFinding[];
  readOnly: true;
  published: false;
};

export interface StandaloneBranchReviewRuntime {
  observeReadOnlyState(signal?: AbortSignal): Promise<{ worktreeDigest: string; refsDigest: string }>;
  review(input: {
    taskId: string;
    axis: ReviewAxis;
    comparisonSource: string;
    specification?: PinnedReviewDocument;
    standards: PinnedReviewDocument;
  }, signal?: AbortSignal): Promise<StandaloneBranchReviewReport>;
}

type MissingSpecification = { status: "MISSING_SPECIFICATION" };

export type StandaloneBranchReviewSummary =
  | {
      status: "DONE";
      taskId: string;
      comparisonSource: string;
      reports: readonly StandaloneBranchReviewReport[];
      specification: PinnedReviewDocument | MissingSpecification;
      readOnly: true;
      published: false;
    }
  | {
      status: "BLOCKED";
      taskId: string;
      reason: "INVALID_REVIEW_CONTEXT" | "REVIEW_EVIDENCE_INVALID" | "REVIEW_FAILED";
      detail: string;
      reports: readonly StandaloneBranchReviewReport[];
      diagnosticsRetained: true;
    };

function validDocument(document: PinnedReviewDocument): boolean {
  return (
    document.source.trim().length > 0 &&
    DIGEST.test(document.digest) &&
    document.contents.trim().length > 0 &&
    createHash("sha256").update(document.contents, "utf8").digest("hex") === document.digest
  );
}

function validReadOnlyState(value: { worktreeDigest: string; refsDigest: string }): boolean {
  return DIGEST.test(value.worktreeDigest) && DIGEST.test(value.refsDigest);
}

function validReviewReport(
  report: StandaloneBranchReviewReport,
  input: Parameters<StandaloneBranchReviewRuntime["review"]>[0],
  other: StandaloneBranchReviewReport | undefined,
): boolean {
  return (
    report.taskId === input.taskId &&
    report.axis === input.axis &&
    report.reviewerId.trim().length > 0 &&
    report.contextId.trim().length > 0 &&
    report.comparisonSource === input.comparisonSource &&
    report.specification?.source === input.specification?.source &&
    report.specification?.digest === input.specification?.digest &&
    report.standardsDigest === input.standards.digest &&
    report.readOnly &&
    !report.published &&
    report.findings.every(
      (finding) =>
        (finding.severity === "BLOCKING" || finding.severity === "NON_BLOCKING") &&
        finding.title.trim().length > 0 &&
        finding.detail.trim().length > 0,
    ) &&
    (!other || (report.reviewerId !== other.reviewerId && report.contextId !== other.contextId))
  );
}

function reviewBlocked(
  taskId: string,
  reason: Extract<StandaloneBranchReviewSummary, { status: "BLOCKED" }>["reason"],
  detail: string,
  reports: readonly StandaloneBranchReviewReport[] = [],
): StandaloneBranchReviewSummary {
  return { status: "BLOCKED", taskId, reason, detail, reports, diagnosticsRetained: true };
}

export async function runStandaloneBranchReview(
  request: StandaloneBranchReviewRequest,
  runtime: StandaloneBranchReviewRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<StandaloneBranchReviewSummary> {
  if (
    !request.taskId.trim() ||
    !validDocument(request.standards) ||
    (request.specification !== undefined && !validDocument(request.specification))
  ) {
    return reviewBlocked(request.taskId, "INVALID_REVIEW_CONTEXT", "Standalone reviews require distinct pinned commits and valid review documents");
  }
  let comparison: Awaited<ReturnType<typeof pinGitBranchComparison>>;
  try {
    comparison = await pinGitBranchComparison({
      repositoryPath: request.repositoryPath,
      namedBase: request.namedBase,
      reviewBranch: request.reviewBranch,
    });
  } catch (error) {
    return reviewBlocked(request.taskId, "INVALID_REVIEW_CONTEXT", error instanceof Error ? error.message : String(error));
  }
  const comparisonSource = comparison.comparisonSource;
  let before: { worktreeDigest: string; refsDigest: string };
  try {
    before = await runtime.observeReadOnlyState(options.signal);
  } catch (error) {
    return reviewBlocked(request.taskId, "REVIEW_FAILED", error instanceof Error ? error.message : String(error));
  }
  if (!validReadOnlyState(before)) {
    return reviewBlocked(request.taskId, "REVIEW_EVIDENCE_INVALID", "The pre-review worktree/ref state is invalid");
  }
  const inputs: Array<Parameters<StandaloneBranchReviewRuntime["review"]>[0]> = [
    { taskId: request.taskId, axis: "STANDARDS", comparisonSource, standards: request.standards },
    ...(request.specification === undefined
      ? []
      : [{ taskId: request.taskId, axis: "SPEC" as const, comparisonSource, specification: request.specification, standards: request.standards }]),
  ];
  const settled: PromiseSettledResult<StandaloneBranchReviewReport>[] = [];
  for (const input of inputs) {
    try {
      settled.push({ status: "fulfilled", value: await runtime.review(input, options.signal) });
    } catch (reason) {
      settled.push({ status: "rejected", reason });
      break;
    }
  }
  const reports = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  let after: { worktreeDigest: string; refsDigest: string };
  try {
    after = await runtime.observeReadOnlyState(options.signal);
  } catch (error) {
    return reviewBlocked(request.taskId, "REVIEW_FAILED", error instanceof Error ? error.message : String(error), reports);
  }
  if (
    !validReadOnlyState(after) ||
    after.worktreeDigest !== before.worktreeDigest ||
    after.refsDigest !== before.refsDigest
  ) {
    return reviewBlocked(request.taskId, "REVIEW_EVIDENCE_INVALID", "Read-only review changed the worktree or refs", reports);
  }
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    return reviewBlocked(request.taskId, "REVIEW_FAILED", rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason), reports);
  }
  const standards = reports.find((report) => report.axis === "STANDARDS");
  const specification = reports.find((report) => report.axis === "SPEC");
  if (
    !standards ||
    !validReviewReport(standards, inputs[0]!, specification) ||
    (request.specification !== undefined &&
      (!specification || !validReviewReport(specification, inputs[1]!, standards)))
  ) {
    return reviewBlocked(request.taskId, "REVIEW_EVIDENCE_INVALID", "Independent review reports must cover the pinned comparison in separate read-only contexts", reports);
  }
  return {
    status: "DONE",
    taskId: request.taskId,
    comparisonSource,
    reports,
    specification: request.specification ?? { status: "MISSING_SPECIFICATION" },
    readOnly: true,
    published: false,
  };
}
