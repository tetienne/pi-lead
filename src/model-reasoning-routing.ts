export const WORKER_TASK_CLASSES = ["ROUTINE", "DEMANDING"] as const;
export const WORKER_CONTEXT_CLASSES = ["STANDARD", "LARGE"] as const;
export const PI_REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
export const MAX_ACTIVE_WORKERS = 2;

export type WorkerTaskClass = (typeof WORKER_TASK_CLASSES)[number];
export type WorkerContextClass = (typeof WORKER_CONTEXT_CLASSES)[number];
export type PiReasoningLevel = (typeof PI_REASONING_LEVELS)[number];
export type WorkerProvider = "openai-codex" | "opencode-go";

export type ConfiguredWorkerRoute = {
  provider: WorkerProvider;
  modelId: string;
  reasoning: PiReasoningLevel;
  /** Effective levels Pi may report for this configured route, including its requested level. */
  allowedEffectiveReasoning: readonly PiReasoningLevel[];
  taskClasses: readonly WorkerTaskClass[];
  contextClasses: readonly WorkerContextClass[];
};

export type WorkerRoutingState = {
  version: number;
  activeWorkers: number;
  maxActiveWorkers: number;
  providers: Readonly<Record<WorkerProvider, { authenticated: boolean; quotaAvailable: boolean }>>;
  /** Native Pi's current provider/model capability observation, not a Jev answer. */
  availableModels: Readonly<Record<WorkerProvider, readonly string[]>>;
  /** A false or unknown admission result must not spend a subscription quota. */
  budgetAvailable: boolean;
  minimumConfidence: number;
  /** Ordered native Pi routes. The first adequate available route is primary. */
  routes: readonly ConfiguredWorkerRoute[];
};

export type JevWorkerResourceJudgment = {
  questionId: "worker-resource";
  type: "resource";
  stateVersion: number;
  taskClass: WorkerTaskClass;
  contextClass: WorkerContextClass;
  confidence: number;
};

export type WorkerRouteSelection = Pick<
  ConfiguredWorkerRoute,
  "provider" | "modelId" | "reasoning" | "allowedEffectiveReasoning"
> & {
  fallback: boolean;
};

export type WorkerRouteOutcome =
  | { status: "READY"; selection: WorkerRouteSelection }
  | {
      status: "BLOCKED";
      reason:
        | "CONCURRENCY_LIMIT"
        | "BUDGET_UNAVAILABLE"
        | "STALE_JUDGMENT"
        | "INVALID_JEV_JUDGMENT"
        | "INSUFFICIENT_CONFIDENCE"
        | "NO_ADEQUATE_ROUTE";
    };

export type EffectivePiRoute = Pick<WorkerRouteSelection, "provider" | "modelId"> & {
  reasoning: PiReasoningLevel;
};

export type WorkerRouteVerification =
  | {
      status: "VERIFIED";
      selection: WorkerRouteSelection;
      effectiveReasoning: PiReasoningLevel;
      clamped: boolean;
    }
  | {
      status: "BLOCKED";
      reason: "UNAPPROVED_SELECTION" | "MODEL_MISMATCH" | "REASONING_MISMATCH";
    };

function includes<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

function isStateVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateJudgment(value: unknown): value is JevWorkerResourceJudgment {
  if (!value || typeof value !== "object") return false;
  const judgment = value as Record<string, unknown>;
  return (
    judgment.questionId === "worker-resource" &&
    judgment.type === "resource" &&
    isStateVersion(judgment.stateVersion) &&
    includes(WORKER_TASK_CLASSES, judgment.taskClass) &&
    includes(WORKER_CONTEXT_CLASSES, judgment.contextClass) &&
    isConfidence(judgment.confidence)
  );
}

function isAdequate(route: ConfiguredWorkerRoute, judgment: JevWorkerResourceJudgment): boolean {
  return (
    route.modelId.trim().length > 0 &&
    includes(PI_REASONING_LEVELS, route.reasoning) &&
    route.allowedEffectiveReasoning.length > 0 &&
    route.allowedEffectiveReasoning.every((level) => includes(PI_REASONING_LEVELS, level)) &&
    route.allowedEffectiveReasoning.includes(route.reasoning) &&
    route.taskClasses.includes(judgment.taskClass) &&
    route.contextClasses.includes(judgment.contextClass)
  );
}

function routeIsCurrentlyAvailable(state: WorkerRoutingState, route: ConfiguredWorkerRoute): boolean {
  const provider = state.providers[route.provider];
  return (
    provider.authenticated &&
    provider.quotaAvailable &&
    state.availableModels[route.provider].includes(route.modelId)
  );
}

/**
 * Deterministically maps a validated semantic resource judgment to an allowed
 * native Pi model/thinking pair. Jev never receives provider, model, quota, or
 * concurrency choices.
 */
export function chooseWorkerRoute(options: {
  state: WorkerRoutingState;
  judgment: unknown;
}): WorkerRouteOutcome {
  const { state, judgment } = options;
  const configuredCapacity = Math.min(state.maxActiveWorkers, MAX_ACTIVE_WORKERS);
  if (
    !Number.isSafeInteger(state.activeWorkers) ||
    !Number.isSafeInteger(state.maxActiveWorkers) ||
    state.activeWorkers < 0 ||
    configuredCapacity < 1 ||
    state.activeWorkers >= configuredCapacity
  ) {
    return { status: "BLOCKED", reason: "CONCURRENCY_LIMIT" };
  }
  if (state.budgetAvailable !== true) return { status: "BLOCKED", reason: "BUDGET_UNAVAILABLE" };
  if (!validateJudgment(judgment)) return { status: "BLOCKED", reason: "INVALID_JEV_JUDGMENT" };
  if (judgment.stateVersion !== state.version) return { status: "BLOCKED", reason: "STALE_JUDGMENT" };
  if (!isConfidence(state.minimumConfidence) || judgment.confidence < state.minimumConfidence) {
    return { status: "BLOCKED", reason: "INSUFFICIENT_CONFIDENCE" };
  }

  const adequateRoutes = state.routes.filter((route) => isAdequate(route, judgment));
  const route = adequateRoutes.find((candidate) => routeIsCurrentlyAvailable(state, candidate));
  if (!route) return { status: "BLOCKED", reason: "NO_ADEQUATE_ROUTE" };

  return {
    status: "READY",
    selection: {
      provider: route.provider,
      modelId: route.modelId,
      reasoning: route.reasoning,
      allowedEffectiveReasoning: route.allowedEffectiveReasoning,
      fallback: route !== adequateRoutes[0],
    },
  };
}

function hasSameReasoningPolicy(
  left: readonly PiReasoningLevel[],
  right: readonly PiReasoningLevel[],
): boolean {
  return left.length === right.length && left.every((level, index) => level === right[index]);
}

function selectionIsCurrentlyAllowed(
  state: WorkerRoutingState,
  judgment: unknown,
  selection: WorkerRouteSelection,
): boolean {
  const current = chooseWorkerRoute({ state, judgment });
  return (
    current.status === "READY" &&
    current.selection.provider === selection.provider &&
    current.selection.modelId === selection.modelId &&
    current.selection.reasoning === selection.reasoning &&
    current.selection.fallback === selection.fallback &&
    hasSameReasoningPolicy(
      current.selection.allowedEffectiveReasoning,
      selection.allowedEffectiveReasoning,
    )
  );
}

/** Verify the native Pi route only after rechecking the policy that issued it. */
export function verifyWorkerRoute(options: {
  state: WorkerRoutingState;
  judgment: unknown;
  selection: WorkerRouteSelection;
  effective: EffectivePiRoute;
}): WorkerRouteVerification {
  const { state, judgment, selection, effective } = options;
  if (!selectionIsCurrentlyAllowed(state, judgment, selection)) {
    return { status: "BLOCKED", reason: "UNAPPROVED_SELECTION" };
  }
  if (effective.provider !== selection.provider || effective.modelId !== selection.modelId) {
    return { status: "BLOCKED", reason: "MODEL_MISMATCH" };
  }
  if (!selection.allowedEffectiveReasoning.includes(effective.reasoning)) {
    return { status: "BLOCKED", reason: "REASONING_MISMATCH" };
  }
  return {
    status: "VERIFIED",
    selection,
    effectiveReasoning: effective.reasoning,
    clamped: effective.reasoning !== selection.reasoning,
  };
}
