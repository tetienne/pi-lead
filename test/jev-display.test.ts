import assert from "node:assert/strict";
import { test } from "node:test";

import type { JevDecision } from "../src/jev.ts";
import { decisionLine, isDecision, jevReport, jevStatus, renderDecision } from "../src/jev-display.ts";

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
    decisionLine(decision({ kind: "overlap", outcome: "independent → parallel", probability: 0.12 })),
    "◆ jev · overlap independent → parallel (p 0.12)",
  );
});

test("the transcript line fits the width", () => {
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 200), "◆ jev · tier standard (conf 0.82)");
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 12), "◆ jev · tie…");
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
    kinds: { overlap: { calls: 11, usd: 0.0031 }, tier: { calls: 3, usd: 0.0011 }, verdict: { calls: 0, usd: 0 } },
  };
  const recent = Array.from({ length: 25 }, (_, index) => decision({ at, outcome: `o${index}` }));
  assert.equal(
    jevReport(usage, 1, recent),
    [
      "Jev today (every Lead session): 14 calls · $0.0042 of $1.00 · $0.9958 left",
      "  tier        3 · $0.0011",
      "  overlap    11 · $0.0031",
      "",
      "Last 20 decisions this session:",
      ...recent.slice(5).map((d) => `  09:05 ◆ jev · tier ${d.outcome}`),
    ].join("\n"),
  );
  assert.equal(
    jevReport({ day: "2026-09-23", usd: 2, calls: 0, kinds: {} }, 1, []),
    "Jev today (every Lead session): 0 calls · $2.0000 of $1.00 · $0.0000 left\n\nNo Jev decisions in this session yet.",
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
