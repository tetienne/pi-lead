import assert from "node:assert/strict";
import { test } from "node:test";

import type { JevDecision } from "../src/jev.ts";
import { decisionLine, isDecision, jevReport, jevStatus, renderDecision, shouldShow } from "../src/jev-display.ts";

const decision = (overrides: Partial<JevDecision>): JevDecision => ({ kind: "tier", outcome: "standard", applied: "jev", at: 0, ...overrides });

test("one line per decision, with its glyph", () => {
  assert.equal(
    decisionLine(decision({ detail: "difficulty 2.1/4", confidence: 0.82 })),
    "◆ jev · tier standard (difficulty 2.1/4, conf 0.82)",
  );
  assert.equal(decisionLine(decision({ kind: "overlap", outcome: "unsure → waits", applied: "fallback" })), "◇ jev · overlap unsure → waits");
  assert.equal(
    decisionLine(decision({ kind: "verdict", outcome: "done → partial", applied: "overridden", detail: "criterion 2 not met" })),
    "▲ jev · verdict done → partial (criterion 2 not met)",
  );
  assert.equal(
    decisionLine(decision({ kind: "egress", outcome: "deny", detail: "POST paste.example/x", probability: 0.02 })),
    "◆ jev · egress deny (POST paste.example/x, p 0.02)",
  );
});

test("the transcript line fits the width", () => {
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 200), "◆ jev · tier standard (conf 0.82)");
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 12), "◆ jev · tie…");
});

test("every Lead decision gets a line, egress only when not allowed", () => {
  const allow = decision({ kind: "egress", outcome: "allow" });
  const deny = decision({ kind: "egress", outcome: "deny" });
  const ask = decision({ kind: "egress", outcome: "unsure → asks you", applied: "fallback" });
  const tier = decision({});
  const fallback = decision({ outcome: "unsure → standard", applied: "fallback" });
  const overridden = decision({ kind: "verdict", outcome: "done → partial", applied: "overridden" });
  const all = [allow, deny, ask, tier, fallback, overridden];
  assert.deepEqual(all.filter(shouldShow), [deny, ask, tier, fallback, overridden]);
});

test("the status segment is short and turns warning, then error, as the budget runs out", () => {
  assert.deepEqual(jevStatus({ calls: 14, usd: 0.004 }, 1), { text: "◆ 14 · $0.004/1.00", level: "dim" });
  assert.equal(jevStatus({ calls: 90, usd: 0.79 }, 1).level, "dim");
  assert.equal(jevStatus({ calls: 90, usd: 0.8 }, 1).level, "warning");
  assert.equal(jevStatus({ calls: 99, usd: 1 }, 1).level, "error");
  assert.equal(jevStatus({ calls: 0, usd: 0 }, 0).level, "error", "a zero budget is spent");
});

test("/jev prints today's totals by kind, the budget left and the session's last decisions", () => {
  const at = new Date(2026, 8, 23, 9, 5).getTime();
  const usage = {
    day: "2026-09-23",
    usd: 0.0042,
    calls: 14,
    kinds: { egress: { calls: 11, usd: 0.0031 }, tier: { calls: 2, usd: 0.0006 }, verdict: { calls: 1, usd: 0.0005 }, overlap: { calls: 0, usd: 0 } },
  };
  const recent = Array.from({ length: 25 }, (_, index) => decision({ at, outcome: `o${index}` }));
  assert.equal(
    jevReport(usage, 1, recent),
    [
      "Jev today (Lead and workers): 14 calls · $0.0042 of $1.00 · $0.9958 left",
      "  tier        2 · $0.0006",
      "  verdict     1 · $0.0005",
      "  egress     11 · $0.0031",
      "",
      "Last 20 decisions this session:",
      ...recent.slice(5).map((d) => `  09:05 ◆ jev · tier ${d.outcome}`),
    ].join("\n"),
  );
  assert.equal(
    jevReport({ day: "2026-09-23", usd: 2, calls: 0, kinds: {} }, 1, []),
    "Jev today (Lead and workers): 0 calls · $2.0000 of $1.00 · $0.0000 left\n\nNo Jev decisions in this session yet.",
  );
});

test("only well-formed stored entries are rendered", () => {
  assert.ok(isDecision(decision({})));
  assert.ok(!isDecision(undefined));
  assert.ok(!isDecision({ kind: "tier", outcome: 3, applied: "jev" }));
  assert.ok(!isDecision({ kind: "tier", outcome: "x", applied: "maybe" }));
  assert.ok(!isDecision({ kind: "tier", outcome: "x", applied: "jev", at: 0, confidence: "high" }));
});

test("a replayed entry cannot inject escape sequences or overflow the line", () => {
  const hostile = decision({ outcome: "x\x1b]0;title\x07漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢" });
  const line = renderDecision(hostile, 40);
  assert.ok(!/[\x00-\x1f]/.test(line), "no control characters");
  assert.ok([...line].length <= 40 && /^[\x20-\x7e◆◇▲→…·]*$/.test(line), "one column per character, within the width");
});

test("a line that fits the width is sanitised too", () => {
  assert.equal(renderDecision(decision({ outcome: "x\u001b[31mred漢" }), 200), "◆ jev · tier x?[31mred?", "escape sequences and wide characters are replaced");
});
