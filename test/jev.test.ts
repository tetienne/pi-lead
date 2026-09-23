import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { noul } from "@typesafe-ai/sdk";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  actionForSeverity,
  band,
  createAskJev,
  createJudge,
  createLedger,
  describeJevProblem,
  tierForDifficulty,
  type AskJev,
  type JevProblem,
} from "../src/jev.ts";

const ledgerIn = async () => createLedger(join(await mkdtemp(join(tmpdir(), "jev-")), "usage.json"));

function fakeAsk(answers: Record<string, unknown>, calls: unknown[] = []): AskJev {
  return async (state, questions) => {
    calls.push({ state, questions });
    return { answers, inputTokens: 1_000 };
  };
}

test("difficulty maps to tiers, with a floor for review and debug", () => {
  assert.equal(tierForDifficulty(0.4, "implement"), "fast");
  assert.equal(tierForDifficulty(2, "implement"), "standard");
  assert.equal(tierForDifficulty(3.4, "implement"), "deep");
  assert.equal(tierForDifficulty(0.4, "review"), "standard");
  assert.equal(tierForDifficulty(3.9, "debug"), "deep");
});

test("review severity and probability bands", () => {
  assert.equal(actionForSeverity(0.5), "none");
  assert.equal(actionForSeverity(2.2), "auto_fix");
  assert.equal(actionForSeverity(3.5), "escalate");
  assert.equal(band(0.9), "yes");
  assert.equal(band(0.1), "no");
  assert.equal(band(0.5), "unsure");
});

test("without a key Jev is unavailable and every judgment falls back", async () => {
  assert.equal(createAskJev(DEFAULT_CONFIG.jev, {}), undefined);
  const judge = createJudge({ config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(judge.available, false);
  assert.equal(await judge.modelTier({ task: "x", kind: "implement" }), undefined);
  assert.deepEqual(await judge.intake({ task: "x", kind: "implement", checkReadiness: true }), {});
  assert.equal(await judge.egress({ task: "x", method: "GET", url: "https://example.com" }), "ask");
  assert.equal(await judge.overlap("a", "b"), undefined);
});

test("model tier uses the difficulty score only when confident", async () => {
  const ledger = await ledgerIn();
  const confident = createJudge({
    ask: fakeAsk({ difficulty: { type: "score", score: 3.2, confidence: 0.9 } }),
    config: DEFAULT_CONFIG.jev,
    ledger,
  });
  assert.deepEqual(await confident.modelTier({ task: "rewrite the scheduler", kind: "implement" }), {
    tier: "deep",
    difficulty: 3.2,
  });
  const unsure = createJudge({
    ask: fakeAsk({ difficulty: { type: "score", score: 3.2, confidence: 0.3 } }),
    config: DEFAULT_CONFIG.jev,
    ledger,
  });
  assert.equal(await unsure.modelTier({ task: "x", kind: "implement" }), undefined);
});

test("malformed answers are rejected", async () => {
  const judge = createJudge({
    ask: fakeAsk({ difficulty: { score: "high", confidence: 2 }, verdict: { choice: "shipit", confidence: 1 } }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.equal(await judge.modelTier({ task: "x", kind: "implement" }), undefined);
  assert.equal(await judge.verdict({ task: "x", reported: "done", summary: "", diffStat: "" }), undefined);
});

test("intake asks readiness and difficulty in one call", async () => {
  const calls: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const judge = createJudge({
    ask: fakeAsk(
      {
        acceptance: { noul: 0.1 },
        bounded: { noul: 0.9 },
        decided: { noul: 0.2 },
        difficulty: { type: "score", score: 3.2, confidence: 0.9 },
      },
      calls,
    ),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await judge.intake({ task: "make it better", kind: "implement", checkReadiness: true }), {
    readiness: { ready: false, missing: ["acceptance", "decided"] },
    tier: { tier: "deep", difficulty: 3.2 },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.state, { kind: "implement", ticket: "make it better" });
  assert.deepEqual(Object.keys(calls[0]!.questions).sort(), ["acceptance", "bounded", "decided", "difficulty"]);

  const tierOnly: typeof calls = [];
  const quiet = createJudge({
    ask: fakeAsk({ difficulty: { type: "score", score: 0.5, confidence: 0.9 } }, tierOnly),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await quiet.intake({ task: "t", kind: "implement", checkReadiness: false }), {
    tier: { tier: "fast", difficulty: 0.5 },
  });
  assert.deepEqual(Object.keys(tierOnly[0]!.questions), ["difficulty"]);
});

test("intake parses readiness and difficulty independently", async () => {
  const badReadiness = createJudge({
    ask: fakeAsk({
      acceptance: { noul: 0.9 },
      bounded: { noul: "yes" },
      decided: { noul: 0.9 },
      difficulty: { type: "score", score: 2, confidence: 0.9 },
    }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await badReadiness.intake({ task: "t", kind: "implement", checkReadiness: true }), {
    tier: { tier: "standard", difficulty: 2 },
  });

  const badDifficulty = createJudge({
    ask: fakeAsk({
      acceptance: { noul: 0.9 },
      bounded: { noul: 0.9 },
      decided: { noul: 0.9 },
      difficulty: { score: "high", confidence: 2 },
    }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await badDifficulty.intake({ task: "t", kind: "implement", checkReadiness: true }), {
    readiness: { ready: true, missing: [] },
  });

  const failing = createJudge({
    ask: async () => {
      throw new Error("503");
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await failing.intake({ task: "t", kind: "implement", checkReadiness: true }), {});
});

test("egress decisions are banded and cached per method, host and path", async () => {
  const calls: unknown[] = [];
  const judge = createJudge({ ask: fakeAsk({ needed: { noul: 0.95 } }, calls), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/a?x=1" }), "allow");
  assert.equal(await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/a?x=2" }), "allow");
  assert.equal(calls.length, 1);
  await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/b" });
  assert.equal(calls.length, 2, "one judged URL does not vouch for the rest of the host");

  const unsure = createJudge({ ask: fakeAsk({ needed: { noul: 0.5 } }), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await unsure.egress({ task: "t", method: "POST", url: "https://paste.example/x" }), "ask");
  const deny = createJudge({ ask: fakeAsk({ needed: { noul: 0.02 } }), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await deny.egress({ task: "t", method: "POST", url: "https://paste.example/x" }), "deny");
});

test("the daily budget stops calls once spent, and failures fall back", async () => {
  const ledger = await ledgerIn();
  await ledger.charge(1);
  const calls: unknown[] = [];
  const judge = createJudge({ ask: fakeAsk({ overlap: { noul: 1 } }, calls), config: DEFAULT_CONFIG.jev, ledger });
  assert.equal(await judge.overlap("a", "b"), undefined);
  assert.equal(calls.length, 0);

  const failing = createJudge({
    ask: async () => {
      throw new Error("503");
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.equal(await failing.failureKind({ task: "t", log: "boom" }), undefined);
});

test("a failing Jev is reported once, clipped, and still falls back", async () => {
  const problems: JevProblem[] = [];
  const judge = createJudge({
    ask: async () => {
      throw new Error(`404 model not found:\n${"x".repeat(500)}`);
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
    onProblem: (problem) => problems.push(problem),
  });
  assert.equal(await judge.overlap("a", "b"), undefined);
  assert.equal(await judge.readiness("t"), undefined);
  assert.equal(await judge.egress({ task: "t", method: "GET", url: "https://example.com/x" }), "ask");
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.kind, "error");
  assert.ok(problems[0]!.message.startsWith("404 model not found: xxx"));
  assert.ok(problems[0]!.message.length <= 201);
  const line = describeJevProblem(problems[0]!);
  assert.match(line, /^Jev is configured but failing \(404 model not found: x+…\); PI Lead falls back to its defaults\.$/);
});

test("a spent budget is reported once, separately from errors", async () => {
  const ledger = await ledgerIn();
  const problems: JevProblem[] = [];
  let fail = true;
  const judge = createJudge({
    ask: async () => {
      if (fail) throw new Error("503");
      return { answers: { overlap: { noul: 0.9 } }, inputTokens: 1_000 };
    },
    config: DEFAULT_CONFIG.jev,
    ledger,
    onProblem: (problem) => problems.push(problem),
  });
  await judge.overlap("a", "b");
  fail = false;
  assert.equal(await judge.overlap("a", "b"), true);
  await ledger.charge(DEFAULT_CONFIG.jev.dailyBudgetUsd);
  await judge.overlap("a", "b");
  await judge.overlap("a", "b");
  assert.deepEqual(
    problems.map((problem) => problem.kind),
    ["error", "budget"],
  );
  assert.equal(
    describeJevProblem(problems[1]!),
    `Jev's daily budget ($${DEFAULT_CONFIG.jev.dailyBudgetUsd}) is spent; PI Lead falls back to its defaults until tomorrow.`,
  );
});

test("a throwing notifier does not break the fallback", async () => {
  const judge = createJudge({
    ask: async () => {
      throw new Error("boom");
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
    onProblem: () => {
      throw new Error("ui gone");
    },
  });
  assert.equal(await judge.overlap("a", "b"), undefined);
});

test("real client errors never carry the API key", async () => {
  const ask = createAskJev(
    DEFAULT_CONFIG.jev,
    { PI_LEAD_JEV_API_KEY: "sk-secret-123" },
    async () => new Response("bad key sk-secret-123", { status: 401 }),
  );
  await assert.rejects(ask!({ ticket: "t" }, { ok: noul("ok?") }), (error: Error) => {
    assert.match(error.message, /401/);
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(error.message, /sk-secret-123/);
    return true;
  });
});

test("calls are charged to the shared ledger", async () => {
  const ledger = await ledgerIn();
  const judge = createJudge({ ask: fakeAsk({ overlap: { noul: 0.9 } }), config: DEFAULT_CONFIG.jev, ledger });
  assert.equal(await judge.overlap("a", "b"), true);
  assert.ok((await ledger.spent()) > 0);
});

test("the real client targets OpenRouter's System One route", async () => {
  const requests: string[] = [];
  const ask = createAskJev(DEFAULT_CONFIG.jev, { PI_LEAD_JEV_API_KEY: "test-key" }, async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ model: "jev-1.13", answers: { a: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 12, output_tokens: 0 } }), {
      headers: { "content-type": "application/json" },
    });
  });
  assert.ok(ask);
  const result = await ask("state", { a: { type: "noul", instructions: "?" } });
  assert.deepEqual(requests, ["https://openrouter.ai/api/v1/systemone"]);
  assert.equal(result.inputTokens, 12);
});
