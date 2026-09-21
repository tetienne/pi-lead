export type FixtureRequest = {
  taskId: string;
  assignmentId: string;
};

export type FixtureLaunchRequest = FixtureRequest & {
  allowedHosts: readonly string[];
  allowWebSockets: false;
  focus: false;
  guestWorkspace: "/workspace";
  hostMounts: readonly string[];
  inheritHostEnvironment: false;
  tabLabel: string;
};

export type OwnedWorker = FixtureRequest & {
  workerId: string;
  vmId: string;
  tabId: string;
  paneId: string;
};

export type FixtureResult = OwnedWorker & {
  output: string;
};

export type CollectedFixtureResult = {
  output: string;
  artifactId: string;
};

export interface FixtureRuntime {
  launch(request: FixtureLaunchRequest, signal?: AbortSignal): Promise<OwnedWorker>;
  waitForResult(worker: OwnedWorker, signal?: AbortSignal): Promise<FixtureResult>;
  collectResult(result: FixtureResult): Promise<CollectedFixtureResult>;
  terminate(worker: OwnedWorker): Promise<{ vmId: string; terminated: boolean }>;
  closeSuccessfulTab(tabId: string): Promise<void>;
}

export type FixtureSummary = FixtureRequest & {
  status: "DONE";
  workerId: string;
  vmId: string;
  tabId: string;
  artifactId: string;
  output: string;
  vmTerminated: true;
};

export type BlockedReason =
  | "CANCELLED"
  | "CLEANUP_UNCONFIRMED"
  | "CONTROLLER_TIMEOUT"
  | "CONCURRENCY_LIMIT"
  | "NATIVE_CONTROL_UNAVAILABLE"
  | "RESULT_IDENTITY_MISMATCH"
  | "RUNTIME_FAILURE";

export type BlockedFixtureSummary = FixtureRequest & {
  status: "BLOCKED";
  reason: BlockedReason;
  workerId: string;
  vmId: string;
  tabId: string;
  diagnosticsRetained: true;
  vmTerminated: boolean;
};

export type UnstartedFixtureSummary = FixtureRequest & {
  status: "BLOCKED";
  reason: "CANCELLED" | "CONCURRENCY_LIMIT" | "CONTROLLER_TIMEOUT" | "NATIVE_CONTROL_UNAVAILABLE";
  detail: string;
  diagnosticsRetained: boolean;
  resourcesStarted: false;
  vmTerminated: boolean;
};

export type FixtureRunSummary = FixtureSummary | BlockedFixtureSummary | UnstartedFixtureSummary;

export class FixtureLaunchFailure extends Error {
  readonly diagnosticsRetained: boolean;
  readonly vmTerminated: boolean;

  constructor(
    message: string,
    diagnosticsRetained: boolean,
    vmTerminated: boolean,
  ) {
    super(message);
    this.name = "FixtureLaunchFailure";
    this.diagnosticsRetained = diagnosticsRetained;
    this.vmTerminated = vmTerminated;
  }
}

export type FixtureRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function resultBelongsToWorker(result: FixtureResult, worker: OwnedWorker): boolean {
  return (
    result.taskId === worker.taskId &&
    result.assignmentId === worker.assignmentId &&
    result.workerId === worker.workerId &&
    result.vmId === worker.vmId &&
    result.tabId === worker.tabId &&
    result.paneId === worker.paneId
  );
}

async function stopAndBlock(
  runtime: FixtureRuntime,
  worker: OwnedWorker,
  reason: BlockedReason,
): Promise<BlockedFixtureSummary> {
  let vmTerminated = false;
  try {
    const termination = await runtime.terminate(worker);
    vmTerminated = termination.terminated && termination.vmId === worker.vmId;
  } catch {
    vmTerminated = false;
  }
  return blockedSummary(worker, vmTerminated ? reason : "CLEANUP_UNCONFIRMED", vmTerminated);
}

function blockedSummary(
  worker: OwnedWorker,
  reason: BlockedReason,
  vmTerminated: boolean,
): BlockedFixtureSummary {
  return {
    status: "BLOCKED",
    reason,
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    diagnosticsRetained: true,
    vmTerminated,
  };
}

export async function runIsolatedFixture(
  request: FixtureRequest,
  runtime: FixtureRuntime,
  options: FixtureRunOptions = {},
): Promise<FixtureRunSummary> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let worker: OwnedWorker;
  try {
    worker = await runtime.launch(
      {
        ...request,
        allowedHosts: [],
        allowWebSockets: false,
        focus: false,
        guestWorkspace: "/workspace",
        hostMounts: [],
        inheritHostEnvironment: false,
        tabLabel: "PI Lead · isolated fixture",
      },
      signal,
    );
  } catch (error) {
    const reason =
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "CONTROLLER_TIMEOUT"
        : signal.aborted
          ? "CANCELLED"
          : "NATIVE_CONTROL_UNAVAILABLE";
    return {
      status: "BLOCKED",
      reason,
      detail: error instanceof Error ? error.message : String(error),
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      diagnosticsRetained: error instanceof FixtureLaunchFailure && error.diagnosticsRetained,
      resourcesStarted: false,
      vmTerminated: error instanceof FixtureLaunchFailure && error.vmTerminated,
    };
  }
  let result: FixtureResult;
  try {
    result = await runtime.waitForResult(worker, signal);
  } catch {
    const reason =
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "CONTROLLER_TIMEOUT"
        : signal.aborted
          ? "CANCELLED"
          : "RUNTIME_FAILURE";
    return stopAndBlock(runtime, worker, reason);
  }

  if (!resultBelongsToWorker(result, worker)) {
    return stopAndBlock(runtime, worker, "RESULT_IDENTITY_MISMATCH");
  }

  let collected: CollectedFixtureResult;
  try {
    collected = await runtime.collectResult(result);
  } catch {
    return stopAndBlock(runtime, worker, "RUNTIME_FAILURE");
  }
  let termination: { vmId: string; terminated: boolean };
  try {
    termination = await runtime.terminate(worker);
  } catch {
    return blockedSummary(worker, "CLEANUP_UNCONFIRMED", false);
  }

  if (!termination.terminated || termination.vmId !== worker.vmId) {
    return blockedSummary(worker, "CLEANUP_UNCONFIRMED", false);
  }

  try {
    await runtime.closeSuccessfulTab(worker.tabId);
  } catch {
    return blockedSummary(worker, "CLEANUP_UNCONFIRMED", true);
  }
  return {
    status: "DONE",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    artifactId: collected.artifactId,
    output: collected.output,
    vmTerminated: true,
  };
}
