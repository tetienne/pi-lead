import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  acceptanceCriteria,
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
  assert.equal(await judge.verdict({ task: "x", reported: "done", summary: "", diffStat: "", commits: "", files: "" }), undefined);
});

test("acceptance criteria are read from a checklist, never guessed", () => {
  const issue = [
    "## What to build",
    "",
    "- not a criterion",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Export writes a CSV file",
    "  with a header row",
    "- [x] `npm test` passes",
    "- Plain bullets count too",
    "",
    "## Blocked by",
    "",
    "- None",
  ].join("\n");
  assert.deepEqual(acceptanceCriteria(issue), ["Export writes a CSV file", "`npm test` passes", "Plain bullets count too"]);

  // to-tickets' local template: a task list without the heading.
  const local = "# 03: Export\n\n**What to build:** export.\n\n- [ ] One\n- [x] Two\n- plain bullet\n";
  assert.deepEqual(acceptanceCriteria(local), ["One", "Two"]);
  assert.deepEqual(acceptanceCriteria("**Acceptance criteria:**\n- A\nThanks"), ["A"]);

  assert.deepEqual(acceptanceCriteria("Add CSV export. AC: test passes.\n- a bullet"), []);
  assert.deepEqual(acceptanceCriteria("Acceptance criteria are in the spec.\n- [ ] x"), ["x"], "prose is not a heading");
  const many = `## Acceptance criteria\n${Array.from({ length: 12 }, (_, i) => `- [ ] c${i}`).join("\n")}`;
  assert.equal(acceptanceCriteria(many).length, 8);
});

test("the verdict sees the evidence; an unmet criterion caps it at partial", async () => {
  const ticket = "Export.\n\n## Acceptance criteria\n\n- [ ] Writes a CSV\n- [ ] Has tests\n";
  const evidence = {
    task: ticket,
    reported: "done" as const,
    summary: "done",
    diffStat: " src/a.ts | 3 ++-",
    commits: "abc feat: export",
    files: "src/a.ts",
    lastTest: { command: "npm test", exitCode: 0 },
  };
  const calls: Array<{ state: any; questions: Record<string, any> }> = [];
  const met = createJudge({
    ask: fakeAsk({ verdict: { choice: "done", confidence: 0.9 }, criterion1: { noul: 0.9 }, criterion2: { noul: 0.5 } }, calls),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.equal(await met.verdict(evidence), "done", "an unsure criterion does not downgrade");
  assert.deepEqual(Object.keys(calls[0]!.questions), ["verdict", "criterion1", "criterion2"], "one call for all questions");
  assert.match(JSON.stringify(calls[0]!.questions.criterion2), /Has tests/);
  assert.equal(calls[0]!.state.commits, "abc feat: export");
  assert.equal(calls[0]!.state.changedFiles, "src/a.ts");
  assert.deepEqual({ ...calls[0]!.state.lastTestRun, note: undefined }, { command: "npm test", exitCode: 0, note: undefined });

  const ledger = await ledgerIn();
  const unmet = (verdict: string | undefined) =>
    createJudge({
      ask: fakeAsk({ ...(verdict ? { verdict: { choice: verdict, confidence: 0.9 } } : {}), criterion1: { noul: 0.9 }, criterion2: { noul: 0.05 } }),
      config: DEFAULT_CONFIG.jev,
      ledger,
    });
  assert.equal(await unmet("done").verdict(evidence), "partial");
  assert.equal(await unmet(undefined).verdict(evidence), "partial");
  assert.equal(await unmet("needs_human").verdict(evidence), "needs_human");

  // No checklist: today's single question, and no test run is stated as such.
  const plain: typeof calls = [];
  const single = createJudge({ ask: fakeAsk({ verdict: { choice: "done", confidence: 0.9 }, criterion1: { noul: 0 } }, plain), config: DEFAULT_CONFIG.jev, ledger });
  assert.equal(await single.verdict({ ...evidence, task: "Add CSV export. AC: test passes.", lastTest: undefined }), "done");
  assert.deepEqual(Object.keys(plain[0]!.questions), ["verdict"]);
  assert.equal(plain[0]!.state.lastTestRun, "none recorded");
});

test("readiness lists the failed checks", async () => {
  const judge = createJudge({
    ask: fakeAsk({ acceptance: { noul: 0.1 }, bounded: { noul: 0.9 }, decided: { noul: 0.2 } }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
  });
  assert.deepEqual(await judge.readiness("make it better"), { ready: false, missing: ["acceptance", "decided"] });
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
