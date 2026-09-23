import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { noul } from "@typesafe-ai/sdk";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  acceptanceCriteria,
  actionForSeverity,
  band,
  createAskJev,
  createJudge,
  createLedger,
  describeJevProblem,
  describeRequest,
  parseUsage,
  tierForDifficulty,
  type AskJev,
  type JevDecision,
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
  assert.equal(await judge.verdict({ task: "x", reported: "done", summary: "", diffStat: "", commits: "", changedFiles: [] }), undefined);
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
    changedFiles: ["src/a.ts"],
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

test("the stuck judgment is banded at 0.2/0.8 and sees the ticket, commands, exit codes and output tails", async () => {
  const calls: any[] = [];
  const runs = [
    { command: "npm test", exitCode: 1, output: "FAIL\n" + "y".repeat(2_000) },
    { command: "npm test", exitCode: -1 },
  ];
  const yes = createJudge({ ask: fakeAsk({ stuck: { noul: 0.9 } }, calls), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await yes.stuck({ task: "t".repeat(5_000), runs }), true);
  const { state, questions } = calls[0];
  assert.ok(state.ticket.length < 3_100);
  assert.equal(state.recentCommands.length, 2);
  assert.equal(state.recentCommands[1].exitCode, -1);
  assert.equal(state.recentCommands[1].outputTail, undefined);
  assert.ok(state.recentCommands[0].outputTail.length < 1_100);
  assert.match(JSON.stringify(questions.stuck), /repeating the same failed approach/);

  for (const [probability, expected] of [[0.1, false], [0.5, undefined], [0.85, true]] as const) {
    const judge = createJudge({ ask: fakeAsk({ stuck: { noul: probability } }), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
    assert.equal(await judge.stuck({ task: "t", runs }), expected, String(probability));
  }
  const noKey = createJudge({ config: DEFAULT_CONFIG.jev, ledger: await ledgerIn() });
  assert.equal(await noKey.stuck({ task: "t", runs }), undefined);
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
  assert.deepEqual(await judge.intake({ task: "t", kind: "implement", checkReadiness: true }), {});
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

test("the ledger reads the older { day, usd } file and counts calls per kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-"));
  const path = join(dir, "usage.json");
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(path, JSON.stringify({ day: today, usd: 0.25 }));
  const ledger = createLedger(path);
  assert.deepEqual(await ledger.usage(), { day: today, usd: 0.25, calls: 0, kinds: {} });
  await ledger.charge(0.001, "egress");
  await ledger.charge(0.001, "egress");
  await ledger.charge(0.002, "verdict");
  await ledger.charge(0.5);
  const usage = await ledger.usage();
  assert.equal(usage.calls, 3, "a charge without a kind adds to the spend only");
  assert.ok(Math.abs(usage.usd - 0.754) < 1e-9);
  assert.equal(usage.kinds.egress?.calls, 2);
  assert.ok(Math.abs(usage.kinds.egress!.usd - 0.002) < 1e-9);
  assert.deepEqual(usage.kinds.verdict, { calls: 1, usd: 0.002 });
  assert.equal(await ledger.spent(), usage.usd);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort(), ["calls", "day", "kinds", "usd"]);

  assert.deepEqual(parseUsage({ day: "1999-01-01", usd: 3, calls: 9 }, today), { day: today, usd: 0, calls: 0, kinds: {} }, "yesterday resets");
  assert.deepEqual(parseUsage({ day: today, usd: 1, calls: -2, kinds: { tier: { calls: "x" }, bogus: { calls: 1 } } }, today), {
    day: today,
    usd: 1,
    calls: 0,
    kinds: { tier: { calls: 0, usd: 0 } },
  });
});

test("parallel charges in one process all land", async () => {
  const ledger = await ledgerIn();
  await Promise.all(Array.from({ length: 20 }, () => ledger.charge(0.001, "egress")));
  const usage = await ledger.usage();
  assert.equal(usage.calls, 20);
  assert.equal(usage.kinds.egress?.calls, 20);
});

test("the judge charges each call to its kind", async () => {
  const ledger = await ledgerIn();
  const judge = createJudge({ ask: fakeAsk({ overlap: { noul: 0.9 }, needed: { noul: 0.9 } }), config: DEFAULT_CONFIG.jev, ledger });
  await judge.overlap("a", "b");
  await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/a" });
  await judge.egress({ task: "t", method: "GET", url: "https://docs.rs/a" });
  const usage = await ledger.usage();
  assert.equal(usage.calls, 2, "a cached egress answer is not a call");
  assert.equal(usage.kinds.overlap?.calls, 1);
  assert.equal(usage.kinds.egress?.calls, 1);
});

const judgeWith = async (answers: Record<string, unknown>) => {
  const decisions: JevDecision[] = [];
  const judge = createJudge({ ask: fakeAsk(answers), config: DEFAULT_CONFIG.jev, ledger: await ledgerIn(), onDecision: (d) => decisions.push(d) });
  return { judge, decisions };
};
const shape = ({ at, ms, usd, ...rest }: JevDecision) => {
  assert.equal(typeof at, "number");
  assert.equal(typeof ms, "number");
  assert.ok(usd! > 0);
  return rest;
};

test("the stuck judgment emits a decision and is charged to its own kind", async () => {
  const runs = [{ command: "npm test", exitCode: 1 }];
  const threshold = "no ≤ 0.2 < unsure < 0.8 ≤ yes";
  for (const [probability, outcome, applied] of [
    [0.9, "yes", "jev"],
    [0.1, "no", "jev"],
    [0.5, "unsure → only a repeated command counts", "fallback"],
  ] as const) {
    const { judge, decisions } = await judgeWith({ stuck: { noul: probability } });
    await judge.stuck({ task: "t", runs });
    assert.deepEqual(decisions.map(shape), [{ kind: "stuck", outcome, applied, probability, threshold }]);
  }
  const ledger = await ledgerIn();
  await createJudge({ ask: fakeAsk({ stuck: { noul: 0.9 } }), config: DEFAULT_CONFIG.jev, ledger }).stuck({ task: "t", runs });
  assert.equal((await ledger.usage()).kinds.stuck?.calls, 1);
  const failing: JevDecision[] = [];
  const broken = createJudge({
    ask: async () => {
      throw new Error("down");
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
    onDecision: (d) => failing.push(d),
  });
  assert.equal(await broken.stuck({ task: "t", runs }), undefined);
  assert.deepEqual(failing.map(({ kind, outcome, applied }) => ({ kind, outcome, applied })), [
    { kind: "stuck", outcome: "failing → only a repeated command counts", applied: "fallback" },
  ]);
});

test("each judgment emits one decision: applied or fallback", async () => {
  const minConf = `conf ≥ ${DEFAULT_CONFIG.jev.minConfidence}`;
  {
    const { judge, decisions } = await judgeWith({ difficulty: { score: 2.1, confidence: 0.82 } });
    await judge.modelTier({ task: "t", kind: "implement" });
    assert.deepEqual(decisions.map(shape), [
      { kind: "tier", outcome: "standard", applied: "jev", confidence: 0.82, threshold: minConf, detail: "difficulty 2.1/4" },
    ]);
  }
  {
    const { judge, decisions } = await judgeWith({ difficulty: { score: 2.1, confidence: 0.3 } });
    await judge.modelTier({ task: "t", kind: "review" });
    assert.deepEqual(decisions.map(shape), [{ kind: "tier", outcome: "unsure → deep", applied: "fallback", confidence: 0.3, threshold: minConf }]);
  }
  {
    const { judge, decisions } = await judgeWith({ acceptance: { noul: 0.1 }, bounded: { noul: 0.9 }, decided: { noul: 0.9 }, difficulty: { score: 1, confidence: 0.9 } });
    await judge.intake({ task: "t", kind: "implement", checkReadiness: true });
    assert.equal(decisions.length, 1);
    assert.deepEqual([decisions[0]!.applied, decisions[0]!.outcome, decisions[0]!.detail], ["jev", "not ready", "missing acceptance"]);
  }
  {
    const { judge, decisions } = await judgeWith({ acceptance: { noul: 0.9 }, bounded: { noul: 0.9 }, decided: { noul: 0.9 }, difficulty: { score: 1, confidence: 0.9 } });
    await judge.intake({ task: "t", kind: "implement", checkReadiness: true });
    assert.deepEqual([decisions[0]!.outcome, decisions[0]!.detail], ["fast", "ready, difficulty 1.0/4"]);
  }
  {
    const { judge, decisions } = await judgeWith({ overlap: { noul: 0.5 } });
    await judge.overlap("a", "b");
    const { judge: sure, decisions: sureDecisions } = await judgeWith({ overlap: { noul: 0.2 } });
    await sure.overlap("a", "b");
    const { judge: unsure, decisions: unsureDecisions } = await judgeWith({ overlap: { noul: "?" } });
    await unsure.overlap("a", "b");
    assert.deepEqual(
      [...decisions, ...sureDecisions, ...unsureDecisions].map((d) => [d.applied, d.outcome, d.probability]),
      [
        ["jev", "overlaps → waits", 0.5],
        ["jev", "independent → parallel", 0.2],
        ["fallback", "unsure → waits", undefined],
      ],
    );
  }
  {
    const evidence = { reported: "done" as const, summary: "", diffStat: "", commits: "", changedFiles: [] };
    const ticket = "## Acceptance criteria\n- [ ] one\n- [ ] two\n";
    const { judge, decisions } = await judgeWith({ verdict: { choice: "done", confidence: 0.9 }, criterion1: { noul: 0.9 }, criterion2: { noul: 0.05 } });
    await judge.verdict({ ...evidence, task: ticket });
    await judge.verdict({ ...evidence, task: ticket, reported: "blocked" });
    await judge.verdict({ ...evidence, task: "no list" });
    const { judge: unsure, decisions: unsureDecisions } = await judgeWith({ verdict: { choice: "done", confidence: 0.2 } });
    await unsure.verdict({ ...evidence, task: "no list" });
    assert.deepEqual(
      [...decisions, ...unsureDecisions].map((d) => [d.applied, d.outcome, d.detail]),
      [
        ["overridden", "done → partial", "criterion 2 not met"],
        ["jev", "partial", "worker's blocked kept, criterion 2 not met"],
        ["jev", "done", undefined],
        ["fallback", "unsure → done stands", undefined],
      ],
    );
  }
  {
    const { judge, decisions } = await judgeWith({ severity: { score: 3.5, confidence: 0.9 } });
    await judge.reviewSeverity("bad");
    const { judge: unsure, decisions: unsureDecisions } = await judgeWith({ severity: { score: 3.5, confidence: 0.1 } });
    await unsure.reviewSeverity("bad");
    assert.deepEqual(
      [...decisions, ...unsureDecisions].map((d) => [d.kind, d.applied, d.outcome, d.detail]),
      [
        ["review", "jev", "escalate", "severity 3.5/4"],
        ["review", "fallback", "unsure → no severity", undefined],
      ],
    );
  }
  {
    const { judge, decisions } = await judgeWith({ kind: { choice: "transient", confidence: 0.9 } });
    await judge.failureKind({ task: "t", log: "x" });
    const { judge: unsure, decisions: unsureDecisions } = await judgeWith({ kind: { choice: "transient", confidence: 0.1 } });
    await unsure.failureKind({ task: "t", log: "x" });
    assert.deepEqual(
      [...decisions, ...unsureDecisions].map((d) => [d.kind, d.applied, d.outcome]),
      [
        ["failure", "jev", "transient"],
        ["failure", "fallback", "unsure → not transient"],
      ],
    );
  }
});

test("egress decisions carry a clipped request and no query string", async () => {
  const { judge, decisions } = await judgeWith({ needed: { noul: 0.02 } });
  await judge.egress({ task: "t", method: "POST", url: `https://paste.example/${"a".repeat(200)}?token=secret` });
  await judge.egress({ task: "t", method: "POST", url: `https://paste.example/${"a".repeat(200)}?token=other` });
  assert.equal(decisions.length, 1, "a cached answer emits nothing");
  const [decision] = decisions;
  assert.deepEqual([decision!.applied, decision!.outcome, decision!.probability], ["jev", "deny", 0.02]);
  assert.doesNotMatch(decision!.detail!, /secret|token/);
  assert.ok(decision!.detail!.startsWith("POST paste.example/aaa"));
  assert.ok(decision!.detail!.length <= "POST ".length + 80);

  const { judge: unsure, decisions: asked } = await judgeWith({ needed: { noul: 0.5 } });
  await unsure.egress({ task: "t", method: "get", url: "https://example.com/x" });
  assert.deepEqual([asked[0]!.applied, asked[0]!.outcome, asked[0]!.detail], ["fallback", "unsure → asks you", "GET example.com/x"]);

  assert.equal(describeRequest("PO\u001bST", "https://exämple.com/p\u0007ath?q=1"), "POST xn--exmple-cua.com/p%07ath");
  assert.equal(describeRequest("GET", "not a url"), "GET (invalid URL)");
});

test("a failing, over-budget or unconfigured Jev: fallbacks name the reason, or nothing is emitted", async () => {
  const decisions: JevDecision[] = [];
  const failing = createJudge({
    ask: async () => {
      throw new Error("503");
    },
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
    onDecision: (d) => decisions.push(d),
  });
  await failing.overlap("a", "b");
  const spent = await ledgerIn();
  await spent.charge(5);
  const broke = createJudge({ ask: fakeAsk({}), config: DEFAULT_CONFIG.jev, ledger: spent, onDecision: (d) => decisions.push(d) });
  await broke.modelTier({ task: "t", kind: "implement" });
  const none = createJudge({ config: DEFAULT_CONFIG.jev, ledger: await ledgerIn(), onDecision: (d) => decisions.push(d) });
  await none.overlap("a", "b");
  assert.deepEqual(
    decisions.map((d) => [d.kind, d.applied, d.outcome, d.usd]),
    [
      ["overlap", "fallback", "failing → waits", undefined],
      ["tier", "fallback", "over budget → standard", undefined],
    ],
  );

  const throwing = createJudge({
    ask: fakeAsk({ overlap: { noul: 0.9 } }),
    config: DEFAULT_CONFIG.jev,
    ledger: await ledgerIn(),
    onDecision: () => {
      throw new Error("ui gone");
    },
  });
  assert.equal(await throwing.overlap("a", "b"), true, "a throwing display never changes the decision");
});
