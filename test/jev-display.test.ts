import assert from "node:assert/strict";
import { test } from "node:test";

import type { JevDecision } from "../src/jev.ts";
import * as display from "../src/jev-display.ts";
import { decisionLine, isDecision, renderDecision } from "../src/jev-display.ts";

const decision = (overrides: Partial<JevDecision>): JevDecision => ({ kind: "tier", outcome: "standard", applied: "jev", at: 0, ...overrides });

test("one line per decision, with its glyph", () => {
  assert.equal(
    decisionLine(decision({ detail: "difficulty 2.1/4", confidence: 0.82 })),
    "◆ jev · tier standard (difficulty 2.1/4, conf 0.82)",
  );
  assert.equal(decisionLine(decision({ outcome: "unsure → standard", applied: "fallback" })), "◇ jev · tier unsure → standard");
  assert.equal(
    decisionLine(decision({ kind: "verdict", outcome: "done → partial", applied: "overridden", detail: "criterion 2 not met" })),
    "▲ jev · verdict done → partial (criterion 2 not met)",
  );
  assert.equal(
    decisionLine({ ...decision({ outcome: "independent → parallel", probability: 0.12 }), kind: "overlap" } as unknown as JevDecision),
    "◆ jev · overlap independent → parallel (p 0.12)",
    "an overlap line stored by an older version still renders",
  );
});

test("the transcript line fits the width", () => {
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 200), "◆ jev · tier standard (conf 0.82)");
  assert.equal(renderDecision(decision({ confidence: 0.82 }), 12), "◆ jev · tie…");
});

test("nothing about spend is left to display", () => {
  assert.deepEqual(Object.keys(display).sort(), ["JEV_ENTRY", "decisionLine", "isDecision", "renderDecision"]);
});

test("only well-formed stored entries are rendered", () => {
  assert.ok(isDecision(decision({})));
  assert.ok(isDecision({ kind: "failure", outcome: "transient", applied: "jev", at: 0 }), "a kind this version no longer asks about");
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
