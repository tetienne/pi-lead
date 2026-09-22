import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { DebugTaskSummary, StandaloneBranchReviewSummary } from "./debug-review-task.ts";
import { projectTaskStateRoot } from "./native-task-recovery.ts";
import type { NativeWorkerObservation } from "./native-worker-observation.ts";
import type { CompleteLocalCodingSummary } from "./review-fix-commit-task.ts";
import { TaskRecordStore, type DurableTaskRecord } from "./task-recovery.ts";
import type { ProposedChangeSummary } from "./proposed-change-task.ts";

const execFileAsync = promisify(execFile);

export type NativeTaskJournal = {
  stateRoot: string;
  workerStarted(observation: NativeWorkerObservation): Promise<void>;
  workerObserved(identity: NativeWorkerObservation["identity"]): Promise<void>;
  workerCleaned(identity: NativeWorkerObservation["identity"]): Promise<void>;
  recordImplementation(summary: CompleteLocalCodingSummary): Promise<void>;
  recordDebug(summary: DebugTaskSummary): Promise<void>;
  recordReview(summary: StandaloneBranchReviewSummary): Promise<void>;
  recordChange(summary: ProposedChangeSummary): Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function actionId(identity: NativeWorkerObservation["identity"]): string {
  return `prompt:${identity.assignmentId}`;
}

function sameIdentity(left: NativeWorkerObservation["identity"], right: NativeWorkerObservation["identity"]): boolean {
  return left.taskId === right.taskId && left.assignmentId === right.assignmentId &&
    left.workerId === right.workerId && left.vmId === right.vmId && left.piSessionId === right.piSessionId &&
    left.tabId === right.tabId && left.paneId === right.paneId;
}

function relativeDirectory(root: string, directory: string): string {
  const fromRoot = relative(resolve(root), resolve(directory));
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Worker diagnostics must remain inside the consuming project's task state");
  }
  return fromRoot;
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd,
    encoding: "utf8",
    env: { HOME: cwd, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Named base did not resolve to a commit");
  return commit;
}

export async function createNativeTaskJournal(options: {
  cwd: string;
  taskId: string;
  workflow: "IMPLEMENT" | "DEBUG" | "REVIEW" | "RESEARCH";
  namedBase?: string;
  branchName: string;
  stateRoot?: string;
}): Promise<NativeTaskJournal> {
  const stateRoot = projectTaskStateRoot(options.cwd, options.stateRoot);
  const store = new TaskRecordStore({ root: stateRoot });
  const baseCommit = options.namedBase ? await resolveCommit(options.cwd, options.namedBase) : "";

  const workerStarted = async (observation: NativeWorkerObservation) => {
    if (observation.identity.taskId !== options.taskId) {
      throw new Error("Worker identity does not belong to the durable task");
    }
    const previous = await store.load(options.taskId);
    const timestamp = nowIso();
    const record: DurableTaskRecord = {
      schemaVersion: 1,
      taskId: options.taskId,
      workflow: options.workflow,
      status: observation.phase,
      identity: observation.identity,
      workerHistory: [...(previous?.workerHistory ?? []), observation.identity],
      baseCommit,
      branchName: options.branchName,
      actions: [
        ...(previous?.actions ?? []),
        { id: actionId(observation.identity), kind: "PROMPT", phase: "INTENDED" },
      ],
      attempts: (previous?.attempts ?? 0) + 1,
      approvals: previous?.approvals ?? [],
      verification: previous?.verification ?? {
        finalRevisionVerified: false,
        checks: [],
        independentReviewArtifactIds: [],
        correctionCycles: 0,
      },
      artifacts: previous?.artifacts ?? [],
      cleanup: { vmTerminated: false, successfulTabClosed: false },
      diagnostics: {
        outcome: "FAILURE",
        logDirectory: relativeDirectory(stateRoot, observation.stateDirectory),
      },
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await store.save(record);
  };

  const workerObserved = async (identity: NativeWorkerObservation["identity"]) => {
    const record = await store.load(options.taskId);
    if (!record || !sameIdentity(record.identity, identity)) {
      throw new Error("Observed worker result does not match durable ownership");
    }
    const id = actionId(identity);
    if (record.actions.some((action) => action.id === id && action.kind === "PROMPT" && action.phase === "OBSERVED")) return;
    await store.save({
      ...record,
      actions: [...record.actions, { id, kind: "PROMPT", phase: "OBSERVED" }],
      artifacts: [...record.artifacts, `${record.diagnostics.logDirectory}/result.json`],
      updatedAt: nowIso(),
    });
  };

  const workerCleaned = async (identity: NativeWorkerObservation["identity"]) => {
    const record = await store.load(options.taskId);
    if (!record || !sameIdentity(record.identity, identity)) {
      throw new Error("Cleaned worker does not match durable ownership");
    }
    await store.save({
      ...record,
      cleanup: { vmTerminated: true, successfulTabClosed: true },
      updatedAt: nowIso(),
    });
  };

  const finish = async (evidence: {
    finalCommit?: string;
    checks: readonly string[];
    reviewArtifactIds: readonly string[];
    artifacts: readonly string[];
    correctionCycles: number;
  }) => {
    const record = await store.load(options.taskId);
    if (!record) throw new Error("No owned worker was recorded for the completed task");
    const completedAt = nowIso();
    await store.save({
      ...record,
      status: "DONE",
      ...(evidence.finalCommit ? { finalCommit: evidence.finalCommit } : {}),
      actions: [
        ...record.actions,
        ...record.actions
          .filter((action) => action.phase === "INTENDED" && !record.actions.some(
            (outcome) => outcome.id === action.id && outcome.kind === action.kind && outcome.phase === "OBSERVED",
          ))
          .map((action) => ({ ...action, phase: "OBSERVED" as const })),
      ],
      verification: {
        finalRevisionVerified: true,
        checks: evidence.checks,
        independentReviewArtifactIds: evidence.reviewArtifactIds,
        correctionCycles: evidence.correctionCycles,
      },
      artifacts: [...new Set([...record.artifacts, ...evidence.artifacts])],
      cleanup: { vmTerminated: true, successfulTabClosed: true },
      diagnostics: { ...record.diagnostics, outcome: "SUCCESS", completedAt },
      updatedAt: completedAt,
    });
  };

  const block = async () => {
    const record = await store.load(options.taskId);
    if (!record) return;
    await store.save({ ...record, status: "BLOCKED", diagnostics: { ...record.diagnostics, outcome: "FAILURE" }, updatedAt: nowIso() });
  };

  return {
    stateRoot,
    workerStarted,
    workerObserved,
    workerCleaned,
    async recordImplementation(summary) {
      if (summary.status !== "DONE") return block();
      await finish({
        finalCommit: summary.commit.commit,
        checks: summary.proposal.validations.map((validation) => validation.command),
        reviewArtifactIds: summary.reviews.map((review) => review.reviewArtifactId),
        artifacts: [summary.proposal.artifactId, ...summary.reviews.map((review) => review.reviewArtifactId)],
        correctionCycles: summary.reviewCycles,
      });
    },
    async recordDebug(summary) {
      if (summary.status !== "DONE") return block();
      await finish({
        finalCommit: summary.implementation.commit.commit,
        checks: [summary.verification.command, ...summary.implementation.proposal.validations.map((validation) => validation.command)],
        reviewArtifactIds: summary.implementation.reviews.map((review) => review.reviewArtifactId),
        artifacts: [
          summary.reproduction.artifactId,
          summary.diagnosis.artifactId,
          summary.implementation.proposal.artifactId,
          summary.verification.artifactId,
        ],
        correctionCycles: summary.implementation.reviewCycles,
      });
    },
    async recordReview(summary) {
      if (summary.status !== "DONE") return block();
      const comparison = summary.comparisonSource.startsWith("git:")
        ? summary.comparisonSource.slice("git:".length)
        : summary.comparisonSource;
      const finalCommit = comparison.split("..")[1];
      if (!finalCommit || !/^[0-9a-f]{40}$/.test(finalCommit)) {
        throw new Error("Standalone review completion is not pinned to a final commit");
      }
      const reportIds = summary.reports.map((report) =>
        createHash("sha256").update(JSON.stringify(report)).digest("hex")
      );
      await finish({ finalCommit, checks: ["read-only worktree/ref snapshot"], reviewArtifactIds: reportIds, artifacts: reportIds, correctionCycles: 0 });
    },
    async recordChange(summary) {
      if (summary.status !== "REVIEW_REQUIRED") return block();
      const record = await store.load(options.taskId);
      if (!record) throw new Error("No owned worker was recorded for the proposed change");
      await store.save({
        ...record,
        status: "BLOCKED",
        blockedReason: "HUMAN_REVIEW_REQUIRED",
        verification: {
          finalRevisionVerified: false,
          checks: summary.validations.map((validation) => validation.command),
          independentReviewArtifactIds: [],
          correctionCycles: 0,
        },
        artifacts: [...new Set([...record.artifacts, summary.artifactId])],
        diagnostics: { ...record.diagnostics, outcome: "FAILURE" },
        updatedAt: nowIso(),
      });
    },
  };
}
