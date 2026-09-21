export const JEV_WORKFLOWS = [
  "CHAT",
  "IMPLEMENT",
  "IDEATE",
  "DEBUG",
  "REVIEW",
  "RESEARCH",
  "TRIAGE",
  "WAYFIND",
  "OPERATE",
] as const;

export type JevWorkflow = (typeof JEV_WORKFLOWS)[number];

export type JevIntentRequest = {
  questionId: "intent";
  state: string;
  candidates: readonly (JevWorkflow | "UNCERTAIN")[];
};

export interface JevIntentTransport {
  decide(request: JevIntentRequest, signal?: AbortSignal): Promise<unknown>;
}

type IntentState = {
  version: number;
  availability: Partial<Record<JevWorkflow, boolean>>;
};

type BudgetOptions = {
  dailyCapUsd: number;
  reservationUsd: number;
  resetHourUtc: number;
};

type RouterOptions = {
  transport: JevIntentTransport;
  getState(): IntentState;
  budget: BudgetOptions;
  now?(): Date;
  minimumConfidence?: number;
};

export type JevRoutingOutcome =
  | { status: "ROUTED"; workflow: JevWorkflow; source: "jev" | "explicit" }
  | { status: "UNAVAILABLE"; workflow: JevWorkflow; reason: "WORKFLOW_UNAVAILABLE" }
  | { status: "CLARIFICATION_REQUIRED"; reason: "AMBIGUOUS_INTENT" }
  | { status: "INVALID_RESPONSE"; reason: "INVALID_JEV_RESPONSE" }
  | { status: "STALE"; reason: "STALE_STATE" }
  | { status: "SERVICE_UNAVAILABLE"; reason: "JEV_UNAVAILABLE" }
  | { status: "BUDGET_BLOCKED"; reason: "DAILY_BUDGET_EXHAUSTED" | "COST_EVIDENCE_MISSING" };

type ValidJudgment = {
  choice: JevWorkflow | "UNCERTAIN";
  confidence: number;
  costUsd?: number;
};

function isWorkflow(value: unknown): value is JevWorkflow {
  return typeof value === "string" && (JEV_WORKFLOWS as readonly string[]).includes(value);
}

function isFiniteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateJudgment(
  value: unknown,
  request: JevIntentRequest,
): ValidJudgment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as Record<string, unknown>;
  if (response.questionId !== request.questionId || response.type !== "choice") return undefined;
  if (!request.candidates.includes(response.choice as JevWorkflow | "UNCERTAIN")) return undefined;
  if (!isFiniteProbability(response.confidence)) return undefined;
  if (!response.probabilities || typeof response.probabilities !== "object") return undefined;
  const probabilities = response.probabilities as Record<string, unknown>;
  if (
    request.candidates.some((candidate) => !isFiniteProbability(probabilities[candidate])) ||
    !isFiniteProbability(probabilities[response.choice as string])
  ) {
    return undefined;
  }
  return {
    choice: response.choice as JevWorkflow | "UNCERTAIN",
    confidence: response.confidence,
    costUsd: isFiniteUsd(response.costUsd) ? response.costUsd : undefined,
  };
}

function resetKey(now: Date, resetHourUtc: number): string {
  const reset = new Date(now);
  reset.setUTCHours(resetHourUtc, 0, 0, 0);
  if (now < reset) reset.setUTCDate(reset.getUTCDate() - 1);
  return reset.toISOString().slice(0, 10);
}

export function createJevIntentRouter(options: RouterOptions) {
  if (options.budget.dailyCapUsd !== 1) {
    throw new Error("Jev daily budget must remain capped at $1");
  }
  if (
    !isFiniteUsd(options.budget.reservationUsd) ||
    options.budget.reservationUsd <= 0 ||
    options.budget.reservationUsd > options.budget.dailyCapUsd ||
    !Number.isInteger(options.budget.resetHourUtc) ||
    options.budget.resetHourUtc < 0 ||
    options.budget.resetHourUtc > 23
  ) {
    throw new Error("Invalid Jev budget configuration");
  }

  const now = options.now ?? (() => new Date());
  const confidenceThreshold = options.minimumConfidence ?? 0.8;
  if (!isFiniteProbability(confidenceThreshold)) throw new Error("Invalid Jev confidence threshold");
  let budgetPeriod: string | undefined;
  let reservedUsd = 0;
  let costEvidenceUncertain = false;
  const cached = new Map<string, Extract<JevRoutingOutcome, { status: "ROUTED" }>>();

  const refreshBudgetPeriod = () => {
    const currentPeriod = resetKey(now(), options.budget.resetHourUtc);
    if (currentPeriod !== budgetPeriod) {
      budgetPeriod = currentPeriod;
      reservedUsd = 0;
      costEvidenceUncertain = false;
      cached.clear();
    }
  };

  return {
    async route(input: string, explicitWorkflow?: JevWorkflow): Promise<JevRoutingOutcome> {
      const state = options.getState();
      if (explicitWorkflow) {
        return state.availability[explicitWorkflow]
          ? { status: "ROUTED", workflow: explicitWorkflow, source: "explicit" }
          : { status: "UNAVAILABLE", workflow: explicitWorkflow, reason: "WORKFLOW_UNAVAILABLE" };
      }
      const candidates = JEV_WORKFLOWS.filter((workflow) => state.availability[workflow]);
      if (candidates.length === 0) {
        return { status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" };
      }
      const request: JevIntentRequest = {
        questionId: "intent",
        state: input.trim(),
        candidates: [...candidates, "UNCERTAIN"],
      };
      const cacheKey = JSON.stringify([state.version, request.state, request.candidates]);
      const prior = cached.get(cacheKey);
      if (prior) return prior;

      refreshBudgetPeriod();
      if (costEvidenceUncertain) {
        return { status: "BUDGET_BLOCKED", reason: "COST_EVIDENCE_MISSING" };
      }
      if (reservedUsd + options.budget.reservationUsd > options.budget.dailyCapUsd) {
        return { status: "BUDGET_BLOCKED", reason: "DAILY_BUDGET_EXHAUSTED" };
      }
      reservedUsd += options.budget.reservationUsd;
      let rawResponse: unknown;
      try {
        rawResponse = await options.transport.decide(request);
      } catch {
        reservedUsd -= options.budget.reservationUsd;
        return { status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" };
      }
      const judgment = validateJudgment(rawResponse, request);
      if (!judgment) {
        return { status: "INVALID_RESPONSE", reason: "INVALID_JEV_RESPONSE" };
      }
      if (judgment.costUsd === undefined) {
        costEvidenceUncertain = true;
        return { status: "BUDGET_BLOCKED", reason: "COST_EVIDENCE_MISSING" };
      }
      if (judgment.costUsd > options.budget.reservationUsd) {
        // The local reservation is deliberately an upper bound. If provider
        // accounting disproves that bound, stop before a judgment can trigger
        // work and require a human to correct the capped configuration.
        reservedUsd = options.budget.dailyCapUsd;
        costEvidenceUncertain = true;
        return { status: "BUDGET_BLOCKED", reason: "COST_EVIDENCE_MISSING" };
      } else {
        reservedUsd -= options.budget.reservationUsd - judgment.costUsd;
      }
      if (options.getState().version !== state.version) {
        return { status: "STALE", reason: "STALE_STATE" };
      }
      if (judgment.choice === "UNCERTAIN" || judgment.confidence < confidenceThreshold) {
        return { status: "CLARIFICATION_REQUIRED", reason: "AMBIGUOUS_INTENT" };
      }
      if (!state.availability[judgment.choice]) {
        return { status: "UNAVAILABLE", workflow: judgment.choice, reason: "WORKFLOW_UNAVAILABLE" };
      }
      const outcome = { status: "ROUTED", workflow: judgment.choice, source: "jev" } as const;
      cached.set(cacheKey, outcome);
      return outcome;
    },
  };
}
