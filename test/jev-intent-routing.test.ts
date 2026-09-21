import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createJevIntentRouter,
  type JevIntentTransport,
  type JevWorkflow,
} from "../src/jev-intent-routing.ts";

const allWorkflows = [
  "CHAT",
  "IMPLEMENT",
  "IDEATE",
  "DEBUG",
  "REVIEW",
  "RESEARCH",
  "TRIAGE",
  "WAYFIND",
  "OPERATE",
] as const satisfies readonly JevWorkflow[];

function response(overrides: Record<string, unknown> = {}) {
  return {
    questionId: "intent",
    type: "choice",
    choice: "CHAT",
    confidence: 0.96,
    probabilities: { CHAT: 0.96, UNCERTAIN: 0.04 },
    costUsd: 0.002,
    ...overrides,
  };
}

function router(
  transport: JevIntentTransport,
  availability: Partial<Record<JevWorkflow, boolean>> = { CHAT: true },
) {
  let version = 1;
  return {
    advanceState() {
      version++;
    },
    router: createJevIntentRouter({
      transport,
      getState: () => ({ version, availability }),
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      budget: { dailyCapUsd: 1, reservationUsd: 0.01, resetHourUtc: 0 },
      minimumConfidence: 0.8,
    }),
  };
}

test("routes one bounded natural-language request only to a currently available workflow", async () => {
  const requests: unknown[] = [];
  const { router: intake } = router({
    async decide(request) {
      requests.push(request);
      return response();
    },
  });

  const outcome = await intake.route("Could you summarize this repository?");

  assert.deepEqual(outcome, { status: "ROUTED", workflow: "CHAT", source: "jev" });
  assert.deepEqual(requests, [
    {
      questionId: "intent",
      state: "Could you summarize this repository?",
      candidates: ["CHAT", "UNCERTAIN"],
    },
  ]);
});

test("valid explicit workflow selection bypasses Jev, while unavailable choices stay visibly unavailable", async () => {
  let calls = 0;
  const { router: intake } = router({
    async decide() {
      calls++;
      return response();
    },
  });

  assert.deepEqual(await intake.route("anything", "CHAT"), {
    status: "ROUTED",
    workflow: "CHAT",
    source: "explicit",
  });
  assert.deepEqual(await intake.route("anything", "REVIEW"), {
    status: "UNAVAILABLE",
    workflow: "REVIEW",
    reason: "WORKFLOW_UNAVAILABLE",
  });
  assert.equal(calls, 0);
});

test("ambiguous, malformed, unknown, stale, and unavailable judgments never route a worker", async () => {
  const cases = [
    [response({ choice: "UNCERTAIN" }), "CLARIFICATION_REQUIRED"],
    [response({ confidence: undefined }), "INVALID_RESPONSE"],
    [response({ choice: "SHELL" }), "INVALID_RESPONSE"],
    [response({ choice: "REVIEW", probabilities: { REVIEW: 0.96, UNCERTAIN: 0.04 } }), "INVALID_RESPONSE"],
  ] as const;
  for (const [judgment, status] of cases) {
    const { router: intake } = router({ async decide() { return judgment; } });
    assert.equal((await intake.route("do something")).status, status);
  }

  let resolve!: (value: ReturnType<typeof response>) => void;
  const { router: intake, advanceState } = router({
    decide: () => new Promise((resolvePromise) => { resolve = resolvePromise; }),
  });
  const pending = intake.route("do something");
  advanceState();
  resolve(response());
  assert.deepEqual(await pending, { status: "STALE", reason: "STALE_STATE" });
});

test("unavailable service and missing cost evidence fail closed, and the capped budget is conservatively reserved", async () => {
  const unavailable = router({ async decide() { throw new Error("gateway unavailable"); } }).router;
  assert.deepEqual(await unavailable.route("summarize"), {
    status: "SERVICE_UNAVAILABLE",
    reason: "JEV_UNAVAILABLE",
  });

  const noCost = router({ async decide() { return response({ costUsd: undefined }); } }).router;
  assert.deepEqual(await noCost.route("summarize"), {
    status: "BUDGET_BLOCKED",
    reason: "COST_EVIDENCE_MISSING",
  });
  assert.deepEqual(await noCost.route("another request"), {
    status: "BUDGET_BLOCKED",
    reason: "COST_EVIDENCE_MISSING",
  });

  const underReserved = router({ async decide() { return response({ costUsd: 0.02 }); } }).router;
  assert.deepEqual(await underReserved.route("summarize"), {
    status: "BUDGET_BLOCKED",
    reason: "COST_EVIDENCE_MISSING",
  });

  const exhausted = createJevIntentRouter({
    transport: { async decide() { return response(); } },
    getState: () => ({ version: 1, availability: { CHAT: true } }),
    now: () => new Date("2026-09-21T12:00:00.000Z"),
    budget: { dailyCapUsd: 1, reservationUsd: 1, resetHourUtc: 0 },
  });
  assert.equal((await exhausted.route("summarize")).status, "ROUTED");
  assert.deepEqual(await exhausted.route("another request"), {
    status: "BUDGET_BLOCKED",
    reason: "DAILY_BUDGET_EXHAUSTED",
  });
});

test("unchanged requests are deduplicated and prompts contain only current input and permitted labels", async () => {
  let calls = 0;
  const { router: intake } = router({
    async decide(request) {
      calls++;
      assert.deepEqual(request.candidates, ["CHAT", "UNCERTAIN"]);
      return response();
    },
  });

  await intake.route("summarize this");
  await intake.route("summarize this");
  assert.equal(calls, 1);
});
