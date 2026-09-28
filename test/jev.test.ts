import assert from "node:assert/strict";
import { test } from "node:test";

import { noul } from "@typesafe-ai/sdk";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  acceptanceCriteria,
  band,
  createAskJev,
  createJudge,
  describeJevProblem,
  JEV_KINDS,
  tierForDifficulty,
  type AskJev,
  type JevDecision,
} from "../src/jev.ts";

function fakeAsk(answers: Record<string, unknown>, calls: unknown[] = []): AskJev {
  return async (state, questions) => {
    calls.push({ state, questions });
    return { answers };
  };
}

test("difficulty maps to tiers, with a floor for review and debug", () => {
  assert.equal(tierForDifficulty(0.4, "implement"), "fast");
  assert.equal(tierForDifficulty(2, "implement"), "standard");
  assert.equal(tierForDifficulty(3.4, "implement"), "deep");
  assert.equal(tierForDifficulty(0.4, "review"), "standard");
  assert.equal(tierForDifficulty(3.9, "debug"), "deep");
});

test("probability bands", () => {
  assert.equal(band(0.9), "yes");
  assert.equal(band(0.1), "no");
  assert.equal(band(0.5), "unsure");
});

test("without a key Jev is unavailable and every judgment falls back", async () => {
  assert.equal(createAskJev(DEFAULT_CONFIG.jev, {}), undefined);
  const judge = createJudge({ config: DEFAULT_CONFIG.jev });
  assert.equal(await judge.modelTier({ task: "x", kind: "implement" }), undefined);
  assert.equal(await judge.verdict({ task: "x", reported: "done", summary: "", diffStat: "", commits: "", changedFiles: [] }), undefined);
});

test("Jev judges only the tier and the verdict: ticket overlap is no longer asked", () => {
  assert.deepEqual([...JEV_KINDS], ["tier", "verdict"]);
  assert.ok(!("overlap" in createJudge({ ask: fakeAsk({}), config: DEFAULT_CONFIG.jev })));
});

test("model tier uses the difficulty score only when confident", async () => {
  const confident = createJudge({
    ask: fakeAsk({ difficulty: { type: "score", score: 3.2, confidence: 0.9 } }),
    config: DEFAULT_CONFIG.jev,
  });
  assert.deepEqual(await confident.modelTier({ task: "rewrite the scheduler", kind: "implement" }), {
    tier: "deep",
    difficulty: 3.2,
  });
  const unsure = createJudge({
    ask: fakeAsk({ difficulty: { type: "score", score: 3.2, confidence: 0.3 } }),
    config: DEFAULT_CONFIG.jev,
  });
  assert.equal(await unsure.modelTier({ task: "x", kind: "implement" }), undefined);
});

test("malformed answers are rejected", async () => {
  const judge = createJudge({
    ask: fakeAsk({ difficulty: { score: "high", confidence: 2 }, verdict: { choice: "shipit", confidence: 1 } }),
    config: DEFAULT_CONFIG.jev,
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
  };
  const calls: Array<{ state: any; questions: Record<string, any> }> = [];
  const met = createJudge({
    ask: fakeAsk({ verdict: { choice: "done", confidence: 0.9 }, criterion1: { noul: 0.9 }, criterion2: { noul: 0.5 } }, calls),
    config: DEFAULT_CONFIG.jev,
  });
  assert.equal(await met.verdict(evidence), "done", "an unsure criterion does not downgrade");
  assert.deepEqual(Object.keys(calls[0]!.questions), ["verdict", "criterion1", "criterion2"], "one call for all questions");
  assert.match(JSON.stringify(calls[0]!.questions.criterion2), /Has tests/);
  assert.equal(calls[0]!.state.commits, "abc feat: export");
  assert.equal(calls[0]!.state.changedFiles, "src/a.ts");
  assert.equal("verification" in calls[0]!.state, false, "the host runs no verify command to show");

  const unmet = (verdict: string | undefined) =>
    createJudge({
      ask: fakeAsk({ ...(verdict ? { verdict: { choice: verdict, confidence: 0.9 } } : {}), criterion1: { noul: 0.9 }, criterion2: { noul: 0.05 } }),
      config: DEFAULT_CONFIG.jev,
    });
  assert.equal(await unmet("done").verdict(evidence), "partial");
  assert.equal(await unmet(undefined).verdict(evidence), "partial");
  assert.equal(await unmet("needs_human").verdict(evidence), "needs_human");

  // No checklist: today's single question.
  const plain: typeof calls = [];
  const single = createJudge({ ask: fakeAsk({ verdict: { choice: "done", confidence: 0.9 }, criterion1: { noul: 0 } }, plain), config: DEFAULT_CONFIG.jev });
  assert.equal(await single.verdict({ ...evidence, task: "Add CSV export. AC: test passes." }), "done");
  assert.deepEqual(Object.keys(plain[0]!.questions), ["verdict"]);
});

test("Jev is never refused for spend: every judgment is asked, and failures fall back", async () => {
  const calls: unknown[] = [];
  const judge = createJudge({ ask: fakeAsk({ difficulty: { score: 3.5, confidence: 0.9 } }, calls), config: DEFAULT_CONFIG.jev });
  for (let index = 0; index < 50; index++) assert.equal((await judge.modelTier({ task: "t", kind: "implement" }))?.tier, "deep");
  assert.equal(calls.length, 50);

  const failing = createJudge({
    ask: async () => {
      throw new Error("503");
    },
    config: DEFAULT_CONFIG.jev,
  });
  assert.equal(await failing.modelTier({ task: "t", kind: "implement" }), undefined);
});

test("a failing Jev is reported once, clipped, and still falls back", async () => {
  const problems: string[] = [];
  const judge = createJudge({
    ask: async () => {
      throw new Error(`404 model not found:\n${"x".repeat(500)}`);
    },
    config: DEFAULT_CONFIG.jev,
    onProblem: (problem) => problems.push(problem),
  });
  assert.equal(await judge.verdict({ task: "t", reported: "done", summary: "", diffStat: "", commits: "", changedFiles: [] }), undefined);
  assert.equal(await judge.modelTier({ task: "t", kind: "implement" }), undefined);
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.startsWith("404 model not found: xxx"));
  assert.ok(problems[0]!.length <= 201);
  const line = describeJevProblem(problems[0]!);
  assert.match(line, /^Jev is configured but failing \(404 model not found: x+…\); PI Lead falls back to its defaults\.$/);
});

test("a failure is reported once, even after Jev recovers and fails again", async () => {
  const problems: string[] = [];
  let fail = true;
  const judge = createJudge({
    ask: async () => {
      if (fail) throw new Error("503");
      return { answers: { difficulty: { score: 3.5, confidence: 0.9 } } };
    },
    config: DEFAULT_CONFIG.jev,
    onProblem: (message) => problems.push(message),
  });
  await judge.modelTier({ task: "t", kind: "implement" });
  fail = false;
  assert.equal((await judge.modelTier({ task: "t", kind: "implement" }))?.tier, "deep");
  fail = true;
  await judge.modelTier({ task: "t", kind: "implement" });
  assert.deepEqual(problems, ["503"]);
  assert.doesNotMatch(describeJevProblem(problems[0]!), /budget/);
});

test("a throwing notifier does not break the fallback", async () => {
  const judge = createJudge({
    ask: async () => {
      throw new Error("boom");
    },
    config: DEFAULT_CONFIG.jev,
    onProblem: () => {
      throw new Error("ui gone");
    },
  });
  assert.equal(await judge.modelTier({ task: "t", kind: "implement" }), undefined);
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
  assert.deepEqual(result, { answers: { a: { type: "noul", noul: 0.7 } } }, "no token count: nothing is charged");
});

const judgeWith = async (answers: Record<string, unknown>) => {
  const decisions: JevDecision[] = [];
  const judge = createJudge({ ask: fakeAsk(answers), config: DEFAULT_CONFIG.jev, onDecision: (d) => decisions.push(d) });
  return { judge, decisions };
};
const shape = ({ at, ...rest }: JevDecision) => {
  assert.equal(typeof at, "number");
  return rest;
};

test("each judgment emits one decision: applied or fallback", async () => {
  {
    const { judge, decisions } = await judgeWith({ difficulty: { score: 2.1, confidence: 0.82 } });
    await judge.modelTier({ task: "t", kind: "implement" });
    assert.deepEqual(decisions.map(shape), [
      { kind: "tier", outcome: "standard", applied: "jev", confidence: 0.82, detail: "difficulty 2.1/4" },
    ]);
  }
  {
    const { judge, decisions } = await judgeWith({ difficulty: { score: 2.1, confidence: 0.3 } });
    await judge.modelTier({ task: "t", kind: "review" });
    assert.deepEqual(decisions.map(shape), [{ kind: "tier", outcome: "unsure → standard", applied: "fallback", confidence: 0.3 }]);
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
});

test("a failing or unconfigured Jev: fallbacks name the reason, or nothing is emitted", async () => {
  const decisions: JevDecision[] = [];
  const failing = createJudge({
    ask: async () => {
      throw new Error("503");
    },
    config: DEFAULT_CONFIG.jev,
    onDecision: (d) => decisions.push(d),
  });
  await failing.modelTier({ task: "t", kind: "implement" });
  const unsure = createJudge({ ask: fakeAsk({}), config: DEFAULT_CONFIG.jev, onDecision: (d) => decisions.push(d) });
  await unsure.modelTier({ task: "t", kind: "implement" });
  const none = createJudge({ config: DEFAULT_CONFIG.jev, onDecision: (d) => decisions.push(d) });
  await none.modelTier({ task: "t", kind: "implement" });
  assert.deepEqual(
    decisions.map((d) => [d.kind, d.applied, d.outcome]),
    [
      ["tier", "fallback", "failing → standard"],
      ["tier", "fallback", "unsure → standard"],
    ],
  );

  const throwing = createJudge({
    ask: fakeAsk({ difficulty: { score: 3.5, confidence: 0.9 } }),
    config: DEFAULT_CONFIG.jev,
    onDecision: () => {
      throw new Error("ui gone");
    },
  });
  assert.equal((await throwing.modelTier({ task: "t", kind: "implement" }))?.tier, "deep", "a throwing display never changes the decision");
});
