export type ProposedChangeRequest = {
  taskId: string;
  assignmentId: string;
  instruction: string;
  repositoryPath: string;
  namedBase: string;
  validationTasks: readonly string[];
  dependencyHosts: readonly string[];
};

export type ProposedChangeLaunchRequest = ProposedChangeRequest & {
  privateWorkspace: true;
  focus: false;
  hostMounts: readonly [];
  allowedDependencyHosts: readonly string[];
};

export type ProposedChangeWorker = Pick<
  ProposedChangeRequest,
  "taskId" | "assignmentId"
> & {
  workerId: string;
  vmId: string;
  tabId: string;
  paneId: string;
  piSessionId: string;
  baseCommit: string;
};

export type ValidationEvidence = {
  task: string;
  command: string;
  passed: boolean;
  exitCode: number;
};

export type ProposedChangeWorkerResult = ProposedChangeWorker & {
  status: "proposed";
  proposedCommit: string;
  validations: readonly ValidationEvidence[];
};

export type ProposedFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldMode: string;
  newMode: string;
  contentBase64?: string;
  binary?: boolean;
  symlinkTarget?: string;
};

export type CollectedProposedChange = {
  artifactId: string;
  files: readonly ProposedFile[];
};

export interface ProposedChangeRuntime {
  launch(request: ProposedChangeLaunchRequest, signal?: AbortSignal): Promise<ProposedChangeWorker>;
  waitForResult(
    worker: ProposedChangeWorker,
    signal?: AbortSignal,
  ): Promise<ProposedChangeWorkerResult>;
  collectResult(result: ProposedChangeWorkerResult): Promise<CollectedProposedChange>;
  terminate(worker: ProposedChangeWorker): Promise<{ vmId: string; terminated: boolean }>;
  closeSuccessfulTab(tabId: string): Promise<void>;
}

export type ProposedChangeBlockedReason =
  | "ARTIFACT_REJECTED"
  | "CANCELLED"
  | "CLEANUP_UNCONFIRMED"
  | "CONTROLLER_TIMEOUT"
  | "DEPENDENCY_DESTINATION_DENIED"
  | "NATIVE_CONTROL_UNAVAILABLE"
  | "RESULT_IDENTITY_MISMATCH"
  | "RUNTIME_FAILURE"
  | "VALIDATION_FAILED";

export class ProposedChangeRuntimeFailure extends Error {
  readonly reason: "DEPENDENCY_DESTINATION_DENIED" | "RUNTIME_FAILURE";

  constructor(
    reason: "DEPENDENCY_DESTINATION_DENIED" | "RUNTIME_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "ProposedChangeRuntimeFailure";
    this.reason = reason;
  }
}

export type ReviewRequiredSummary = ProposedChangeWorker &
  CollectedProposedChange & {
    status: "REVIEW_REQUIRED";
    proposedCommit: string;
    validations: readonly ValidationEvidence[];
    humanGate: true;
    hostCommitted: false;
    published: false;
    vmTerminated: true;
  };

export type ProposedChangeBlockedSummary = ProposedChangeWorker & {
  status: "BLOCKED";
  reason: ProposedChangeBlockedReason;
  detail?: string;
  diagnosticsRetained: true;
  vmTerminated: boolean;
};

export type UnstartedProposedChangeSummary = Pick<
  ProposedChangeRequest,
  "taskId" | "assignmentId"
> & {
  status: "BLOCKED";
  reason:
    | "CANCELLED"
    | "CONCURRENCY_LIMIT"
    | "CONTROLLER_TIMEOUT"
    | "NATIVE_CONTROL_UNAVAILABLE";
  detail: string;
  diagnosticsRetained: boolean;
  resourcesStarted: false;
  vmTerminated: boolean;
};

export type ProposedChangeSummary =
  | ReviewRequiredSummary
  | ProposedChangeBlockedSummary
  | UnstartedProposedChangeSummary;

export class ProposedChangeLaunchFailure extends Error {
  readonly reason: UnstartedProposedChangeSummary["reason"];
  readonly diagnosticsRetained: boolean;
  readonly vmTerminated: boolean;

  constructor(
    reason: UnstartedProposedChangeSummary["reason"],
    message: string,
    diagnosticsRetained: boolean,
    vmTerminated: boolean,
  ) {
    super(message);
    this.name = "ProposedChangeLaunchFailure";
    this.reason = reason;
    this.diagnosticsRetained = diagnosticsRetained;
    this.vmTerminated = vmTerminated;
  }
}

function identityMatches(
  result: ProposedChangeWorkerResult,
  worker: ProposedChangeWorker,
): boolean {
  return (
    result.taskId === worker.taskId &&
    result.assignmentId === worker.assignmentId &&
    result.workerId === worker.workerId &&
    result.vmId === worker.vmId &&
    result.tabId === worker.tabId &&
    result.paneId === worker.paneId &&
    result.piSessionId === worker.piSessionId &&
    result.baseCommit === worker.baseCommit
  );
}

function blocked(
  worker: ProposedChangeWorker,
  reason: ProposedChangeBlockedReason,
  vmTerminated: boolean,
  detail?: string,
): ProposedChangeBlockedSummary {
  return {
    status: "BLOCKED",
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...worker,
    diagnosticsRetained: true,
    vmTerminated,
  };
}

async function stopAndBlock(
  runtime: ProposedChangeRuntime,
  worker: ProposedChangeWorker,
  reason: ProposedChangeBlockedReason,
  detail?: string,
): Promise<ProposedChangeBlockedSummary> {
  let vmTerminated = false;
  try {
    const termination = await runtime.terminate(worker);
    vmTerminated = termination.vmId === worker.vmId && termination.terminated;
  } catch {
    vmTerminated = false;
  }
  return blocked(
    worker,
    vmTerminated ? reason : "CLEANUP_UNCONFIRMED",
    vmTerminated,
    detail,
  );
}

function validationMatchesRequest(
  expected: readonly string[],
  evidence: readonly ValidationEvidence[],
): boolean {
  return (
    evidence.length === expected.length &&
    evidence.every(
      (entry, index) =>
        entry.task === expected[index] &&
        entry.command === `mise run ${entry.task}` &&
        entry.passed &&
        entry.exitCode === 0,
    )
  );
}

export async function runProposedChangeTask(
  request: ProposedChangeRequest,
  runtime: ProposedChangeRuntime,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProposedChangeSummary> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let worker: ProposedChangeWorker;
  try {
    worker = await runtime.launch(
      {
        ...request,
        privateWorkspace: true,
        focus: false,
        hostMounts: [],
        allowedDependencyHosts: [...request.dependencyHosts],
      },
      signal,
    );
  } catch (error) {
    const reason =
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "CONTROLLER_TIMEOUT"
        : signal.aborted
          ? "CANCELLED"
          : error instanceof ProposedChangeLaunchFailure
            ? error.reason
            : "NATIVE_CONTROL_UNAVAILABLE";
    return {
      status: "BLOCKED",
      reason,
      detail: error instanceof Error ? error.message : String(error),
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      diagnosticsRetained:
        error instanceof ProposedChangeLaunchFailure && error.diagnosticsRetained,
      resourcesStarted: false,
      vmTerminated: error instanceof ProposedChangeLaunchFailure && error.vmTerminated,
    };
  }

  let result: ProposedChangeWorkerResult;
  try {
    result = await runtime.waitForResult(worker, signal);
  } catch (error) {
    const reason: ProposedChangeBlockedReason =
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "CONTROLLER_TIMEOUT"
        : signal.aborted
          ? "CANCELLED"
          : error instanceof ProposedChangeRuntimeFailure
            ? error.reason
            : "RUNTIME_FAILURE";
    return stopAndBlock(
      runtime,
      worker,
      reason,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!identityMatches(result, worker)) {
    return stopAndBlock(runtime, worker, "RESULT_IDENTITY_MISMATCH");
  }
  if (!validationMatchesRequest(request.validationTasks, result.validations)) {
    return stopAndBlock(runtime, worker, "VALIDATION_FAILED");
  }

  let collected: CollectedProposedChange;
  try {
    collected = await runtime.collectResult(result);
  } catch (error) {
    return stopAndBlock(
      runtime,
      worker,
      "ARTIFACT_REJECTED",
      error instanceof Error ? error.message : String(error),
    );
  }
  let termination: { vmId: string; terminated: boolean };
  try {
    termination = await runtime.terminate(worker);
  } catch {
    return blocked(worker, "CLEANUP_UNCONFIRMED", false);
  }
  if (termination.vmId !== worker.vmId || !termination.terminated) {
    return blocked(worker, "CLEANUP_UNCONFIRMED", false);
  }
  try {
    await runtime.closeSuccessfulTab(worker.tabId);
  } catch {
    return blocked(worker, "CLEANUP_UNCONFIRMED", true);
  }
  return {
    status: "REVIEW_REQUIRED",
    ...worker,
    proposedCommit: result.proposedCommit,
    validations: result.validations,
    ...collected,
    humanGate: true,
    hostCommitted: false,
    published: false,
    vmTerminated: true,
  };
}
