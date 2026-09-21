import { MAX_CHATGPT_TASK_CHARS } from "./chatgpt-input.ts";

export type ChatGptTaskRequest = {
  taskId: string;
  assignmentId: string;
  question: string;
};

export type ChatGptLaunchRequest = ChatGptTaskRequest & {
  provider: "openai-codex";
  transport: "sse";
  cacheWarming: "off";
  allowedHosts: readonly ["chatgpt.com"];
  allowWebSockets: false;
  focus: false;
  hostMounts: readonly [];
  inheritHostEnvironment: false;
  tabLabel: string;
};

export type ChatGptWorker = Pick<ChatGptTaskRequest, "taskId" | "assignmentId"> & {
  workerId: string;
  vmId: string;
  tabId: string;
  paneId: string;
  piSessionId: string;
};

export type NativePiEvent = "agent_start" | "message_end" | "agent_end" | "agent_settled";
export type ProviderFailure = "QUOTA_EXHAUSTED" | "REFRESH_FAILED" | "MODEL_UNAVAILABLE";

export type AnsweredChatGptResult = ChatGptWorker & {
  status: "answered";
  output: string;
  nativeEvents: readonly NativePiEvent[];
  stopReason: string;
};

export type FailedChatGptResult = ChatGptWorker & {
  status: "failed";
  failure: ProviderFailure;
  detail: string;
  nativeEvents: readonly NativePiEvent[];
};

export type ChatGptWorkerResult = AnsweredChatGptResult | FailedChatGptResult;

export interface ChatGptTaskRuntime {
  launch(request: ChatGptLaunchRequest, signal?: AbortSignal): Promise<ChatGptWorker>;
  waitForResult(worker: ChatGptWorker, signal?: AbortSignal): Promise<ChatGptWorkerResult>;
  collectResult(result: AnsweredChatGptResult): Promise<{ artifactId: string; output: string }>;
  terminate(worker: ChatGptWorker): Promise<{ vmId: string; terminated: boolean }>;
  closeSuccessfulTab(tabId: string): Promise<void>;
}

export type ChatGptTaskSummary = ChatGptWorker & {
  status: "DONE";
  artifactId: string;
  output: string;
  vmTerminated: true;
};

export type ChatGptBlockedReason =
  | ProviderFailure
  | "CANCELLED"
  | "CLEANUP_UNCONFIRMED"
  | "CONCURRENCY_LIMIT"
  | "CONTROLLER_TIMEOUT"
  | "NATIVE_CONTROL_UNAVAILABLE"
  | "PI_LIFECYCLE_INCOMPLETE"
  | "RESULT_IDENTITY_MISMATCH"
  | "RUNTIME_FAILURE";

export type StartedChatGptBlockedSummary = ChatGptWorker & {
  status: "BLOCKED";
  reason: ChatGptBlockedReason;
  detail?: string;
  diagnosticsRetained: true;
  vmTerminated: boolean;
};

export type UnstartedChatGptBlockedSummary = Pick<
  ChatGptTaskRequest,
  "taskId" | "assignmentId"
> & {
  status: "BLOCKED";
  reason:
    | "CANCELLED"
    | "CONCURRENCY_LIMIT"
    | "CONTROLLER_TIMEOUT"
    | "MODEL_UNAVAILABLE"
    | "REFRESH_FAILED"
    | "NATIVE_CONTROL_UNAVAILABLE";
  detail: string;
  diagnosticsRetained: boolean;
  resourcesStarted: false;
  vmTerminated: boolean;
};

export type ChatGptRunSummary =
  | ChatGptTaskSummary
  | StartedChatGptBlockedSummary
  | UnstartedChatGptBlockedSummary;

export class ChatGptLaunchFailure extends Error {
  readonly reason: UnstartedChatGptBlockedSummary["reason"];
  readonly diagnosticsRetained: boolean;
  readonly vmTerminated: boolean;

  constructor(
    reason: UnstartedChatGptBlockedSummary["reason"],
    message: string,
    diagnosticsRetained: boolean,
    vmTerminated: boolean,
  ) {
    super(message);
    this.name = "ChatGptLaunchFailure";
    this.reason = reason;
    this.diagnosticsRetained = diagnosticsRetained;
    this.vmTerminated = vmTerminated;
  }
}

function identityMatches(result: ChatGptWorkerResult, worker: ChatGptWorker): boolean {
  return (
    result.taskId === worker.taskId &&
    result.assignmentId === worker.assignmentId &&
    result.workerId === worker.workerId &&
    result.vmId === worker.vmId &&
    result.tabId === worker.tabId &&
    result.paneId === worker.paneId &&
    result.piSessionId === worker.piSessionId
  );
}

function hasCompletePiEvidence(result: AnsweredChatGptResult): boolean {
  const events = new Set(result.nativeEvents);
  return (
    events.has("agent_start") &&
    events.has("message_end") &&
    events.has("agent_end") &&
    result.output.trim().length > 0 &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted"
  );
}

function blocked(
  worker: ChatGptWorker,
  reason: ChatGptBlockedReason,
  vmTerminated: boolean,
  detail?: string,
): StartedChatGptBlockedSummary {
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
  runtime: ChatGptTaskRuntime,
  worker: ChatGptWorker,
  reason: ChatGptBlockedReason,
  detail?: string,
): Promise<StartedChatGptBlockedSummary> {
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

export async function runReadOnlyChatGptTask(
  request: ChatGptTaskRequest,
  runtime: ChatGptTaskRuntime,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChatGptRunSummary> {
  if (request.question.trim().length === 0 || request.question.length > MAX_CHATGPT_TASK_CHARS) {
    return {
      status: "BLOCKED",
      reason: "NATIVE_CONTROL_UNAVAILABLE",
      detail: `Prepared worker question must contain 1–${MAX_CHATGPT_TASK_CHARS} characters`,
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      diagnosticsRetained: false,
      resourcesStarted: false,
      vmTerminated: true,
    };
  }
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let worker: ChatGptWorker;
  try {
    worker = await runtime.launch(
      {
        ...request,
        provider: "openai-codex",
        transport: "sse",
        cacheWarming: "off",
        allowedHosts: ["chatgpt.com"],
        allowWebSockets: false,
        focus: false,
        hostMounts: [],
        inheritHostEnvironment: false,
        tabLabel: "PI Lead · ChatGPT read-only worker",
      },
      signal,
    );
  } catch (error) {
    const reason =
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "CONTROLLER_TIMEOUT"
        : signal.aborted
          ? "CANCELLED"
          : error instanceof ChatGptLaunchFailure
            ? error.reason
            : "NATIVE_CONTROL_UNAVAILABLE";
    return {
      status: "BLOCKED",
      reason,
      detail: error instanceof Error ? error.message : String(error),
      taskId: request.taskId,
      assignmentId: request.assignmentId,
      diagnosticsRetained: error instanceof ChatGptLaunchFailure && error.diagnosticsRetained,
      resourcesStarted: false,
      vmTerminated: error instanceof ChatGptLaunchFailure && error.vmTerminated,
    };
  }

  let result: ChatGptWorkerResult;
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
  if (!identityMatches(result, worker)) {
    return stopAndBlock(runtime, worker, "RESULT_IDENTITY_MISMATCH");
  }
  if (result.status === "failed") {
    return stopAndBlock(runtime, worker, result.failure, result.detail);
  }
  if (!hasCompletePiEvidence(result)) {
    return stopAndBlock(runtime, worker, "PI_LIFECYCLE_INCOMPLETE");
  }

  let collected: { artifactId: string; output: string };
  try {
    collected = await runtime.collectResult(result);
  } catch {
    return stopAndBlock(runtime, worker, "RUNTIME_FAILURE");
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
    status: "DONE",
    ...worker,
    artifactId: collected.artifactId,
    output: collected.output,
    vmTerminated: true,
  };
}
