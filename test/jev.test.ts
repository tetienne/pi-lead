import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  actionForSeverity,
  band,
  createAskJev,
  createJudge,
  createLedger,
  tierForDifficulty,
  type AskJev,
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
  assert.equal(await judge.readiness("x"), undefined);
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

test("readiness lists the failed checks", async () => {
  const judge = createJudge({
    ask: fakeAsk({ acceptance: { noul: 0.1 }, bounded: { noul: 0.9 }, decided: { noul: 0.2 } }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await judge.readiness("make it better"), { ready: false, missing: ["acceptance", "decided"] });
});

test("egress decisions are banded and cached per method and host", async () => {
  const calls: unknown[] = [];
  const judge = createJudge({ ask: fakeAsk({ needed: { noul: 0.95 } }, calls), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/a" }), "allow");
  assert.equal(await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/b" }), "allow");
  assert.equal(calls.length, 1);

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
