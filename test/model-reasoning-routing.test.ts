import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseWorkerRoute,
  verifyWorkerRoute,
  type WorkerRoutingState,
} from "../src/model-reasoning-routing.ts";

const routes = [
  {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    reasoning: "high",
    allowedEffectiveReasoning: ["medium", "high"],
    taskClasses: ["DEMANDING"],
    contextClasses: ["STANDARD", "LARGE"],
  },
  {
    provider: "openai-codex",
    modelId: "gpt-5.6-mini",
    reasoning: "medium",
    allowedEffectiveReasoning: ["medium"],
    taskClasses: ["ROUTINE"],
    contextClasses: ["STANDARD"],
  },
  {
    provider: "opencode-go",
    modelId: "gpt-5.6-luna",
    reasoning: "high",
    allowedEffectiveReasoning: ["high"],
    taskClasses: ["ROUTINE", "DEMANDING"],
    contextClasses: ["STANDARD", "LARGE"],
  },
] as const;

function state(overrides: Partial<WorkerRoutingState> = {}): WorkerRoutingState {
  return {
    version: 1,
    activeWorkers: 0,
    maxActiveWorkers: 2,
    providers: {
      "openai-codex": { authenticated: true, quotaAvailable: true },
      "opencode-go": { authenticated: false, quotaAvailable: false },
    },
    availableModels: {
      "openai-codex": ["gpt-5.6-luna", "gpt-5.6-mini"],
      "opencode-go": ["gpt-5.6-luna"],
    },
    budgetAvailable: true,
    minimumConfidence: 0.8,
    routes,
    ...overrides,
  };
}

const demandingLargeJudgment = {
  questionId: "worker-resource",
  type: "resource",
  stateVersion: 1,
  taskClass: "DEMANDING",
  contextClass: "LARGE",
  confidence: 0.95,
};

test("maps a validated semantic resource judgment to a configured native Pi route", () => {
  const outcome = chooseWorkerRoute({
    state: state(),
    judgment: demandingLargeJudgment,
  });

  assert.deepEqual(outcome, {
    status: "READY",
    selection: {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      reasoning: "high",
      allowedEffectiveReasoning: ["medium", "high"],
      fallback: false,
    },
  });
});

test("selects a second configured ChatGPT route for an adequate routine task", () => {
  const outcome = chooseWorkerRoute({
    state: state(),
    judgment: {
      ...demandingLargeJudgment,
      taskClass: "ROUTINE",
      contextClass: "STANDARD",
    },
  });

  assert.deepEqual(outcome, {
    status: "READY",
    selection: {
      provider: "openai-codex",
      modelId: "gpt-5.6-mini",
      reasoning: "medium",
      allowedEffectiveReasoning: ["medium"],
      fallback: false,
    },
  });
});

test("uses OpenCode Go automatically when an adequate configured ChatGPT route loses quota", () => {
  const outcome = chooseWorkerRoute({
    state: state({
      providers: {
        "openai-codex": { authenticated: true, quotaAvailable: false },
        "opencode-go": { authenticated: true, quotaAvailable: true },
      },
    }),
    judgment: demandingLargeJudgment,
  });

  assert.deepEqual(outcome, {
    status: "READY",
    selection: {
      provider: "opencode-go",
      modelId: "gpt-5.6-luna",
      reasoning: "high",
      allowedEffectiveReasoning: ["high"],
      fallback: true,
    },
  });
});

test("blocks when no authenticated, in-quota route is adequate for the judgment", () => {
  const outcome = chooseWorkerRoute({
    state: state({
      providers: {
        "openai-codex": { authenticated: true, quotaAvailable: false },
        "opencode-go": { authenticated: false, quotaAvailable: false },
      },
    }),
    judgment: demandingLargeJudgment,
  });

  assert.deepEqual(outcome, { status: "BLOCKED", reason: "NO_ADEQUATE_ROUTE" });
});

test("fails closed for stale or malformed Jev resource judgments", () => {
  assert.deepEqual(
    chooseWorkerRoute({
      state: state({ version: 2 }),
      judgment: { ...demandingLargeJudgment, stateVersion: 1 },
    }),
    { status: "BLOCKED", reason: "STALE_JUDGMENT" },
  );
  assert.deepEqual(
    chooseWorkerRoute({
      state: state(),
      judgment: { ...demandingLargeJudgment, taskClass: "UNBOUNDED" },
    }),
    { status: "BLOCKED", reason: "INVALID_JEV_JUDGMENT" },
  );
});

test("blocks low-confidence judgments, exhausted routing budget, and a third worker", () => {
  assert.deepEqual(
    chooseWorkerRoute({
      state: state(),
      judgment: { ...demandingLargeJudgment, confidence: 0.79 },
    }),
    { status: "BLOCKED", reason: "INSUFFICIENT_CONFIDENCE" },
  );
  assert.deepEqual(
    chooseWorkerRoute({
      state: state({ budgetAvailable: false }),
      judgment: demandingLargeJudgment,
    }),
    { status: "BLOCKED", reason: "BUDGET_UNAVAILABLE" },
  );
  assert.deepEqual(
    chooseWorkerRoute({
      state: state({ activeWorkers: 2, maxActiveWorkers: 3 }),
      judgment: demandingLargeJudgment,
    }),
    { status: "BLOCKED", reason: "CONCURRENCY_LIMIT" },
  );
});

test("does not select a configured model missing from native Pi's current catalog", () => {
  const outcome = chooseWorkerRoute({
    state: state({
      availableModels: {
        "openai-codex": ["gpt-5.6-mini"],
        "opencode-go": [],
      },
    }),
    judgment: demandingLargeJudgment,
  });

  assert.deepEqual(outcome, { status: "BLOCKED", reason: "NO_ADEQUATE_ROUTE" });
});

test("reports Pi's effective clamped thinking only when policy preapproved it", () => {
  const route = chooseWorkerRoute({ state: state(), judgment: demandingLargeJudgment });
  assert.equal(route.status, "READY");
  if (route.status !== "READY") return;

  assert.deepEqual(
    verifyWorkerRoute({
      state: state(),
      judgment: demandingLargeJudgment,
      selection: route.selection,
      effective: {
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        reasoning: "medium",
      },
    }),
    {
      status: "VERIFIED",
      selection: route.selection,
      effectiveReasoning: "medium",
      clamped: true,
    },
  );
});

test("blocks a native Pi model or thinking result that was not selected by policy", () => {
  const route = chooseWorkerRoute({ state: state(), judgment: demandingLargeJudgment });
  assert.equal(route.status, "READY");
  if (route.status !== "READY") return;

  assert.deepEqual(
    verifyWorkerRoute({
      state: state(),
      judgment: demandingLargeJudgment,
      selection: route.selection,
      effective: {
        provider: "openai-codex",
        modelId: "unconfigured-model",
        reasoning: "high",
      },
    }),
    { status: "BLOCKED", reason: "MODEL_MISMATCH" },
  );
  assert.deepEqual(
    verifyWorkerRoute({
      state: state(),
      judgment: demandingLargeJudgment,
      selection: route.selection,
      effective: {
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        reasoning: "low",
      },
    }),
    { status: "BLOCKED", reason: "REASONING_MISMATCH" },
  );
});

test("refuses to certify a route that was not issued by current configured policy", () => {
  assert.deepEqual(
    verifyWorkerRoute({
      state: state(),
      judgment: demandingLargeJudgment,
      selection: {
        provider: "openai-codex",
        modelId: "unapproved-model",
        reasoning: "high",
        allowedEffectiveReasoning: ["high"],
        fallback: false,
      },
      effective: {
        provider: "openai-codex",
        modelId: "unapproved-model",
        reasoning: "high",
      },
    }),
    { status: "BLOCKED", reason: "UNAPPROVED_SELECTION" },
  );
});

test("rechecks current budget, capacity, and confidence policy before certifying Pi's route", () => {
  const route = chooseWorkerRoute({ state: state(), judgment: demandingLargeJudgment });
  assert.equal(route.status, "READY");
  if (route.status !== "READY") return;
  const request = {
    judgment: demandingLargeJudgment,
    selection: route.selection,
    effective: {
      provider: "openai-codex" as const,
      modelId: "gpt-5.6-luna",
      reasoning: "high" as const,
    },
  };

  for (const changedState of [
    state({ budgetAvailable: false }),
    state({ activeWorkers: 2 }),
    state({ minimumConfidence: 0.96 }),
  ]) {
    assert.deepEqual(
      verifyWorkerRoute({ state: changedState, ...request }),
      { status: "BLOCKED", reason: "UNAPPROVED_SELECTION" },
    );
  }
});
