import assert from "node:assert/strict";
import { test } from "node:test";

import type { StartResult, WorkerInfo } from "../src/delegate.ts";
import { cleanLines, delegateCall, delegateResult, workerCall, workerResult, type Paint } from "../src/tool-display.ts";

/** Colours as visible tags, so tests see what is painted how. */
const paint: Paint = (color, text) => (color === "dim" ? text : `<${color}>${text}</${color}>`);
const plain: Paint = (_color, text) => text;

const worker = (overrides: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id: "a1b2c3d4e5f6",
  title: "Add CSV export",
  kind: "implement",
  state: "running",
  route: { model: "openai-codex/gpt-6-sol", thinking: "high", tier: "standard" },
  tabOpen: true,
  ...overrides,
});

test("a delegate call shows kind, title and the start of the task", () => {
  assert.equal(
    delegateCall({ kind: "implement", title: "Add CSV export", task: "Add a CSV export to the reports page.\nAcceptance: …" }, paint),
    "<toolTitle>delegate </toolTitle><accent>implement</accent> Add CSV export\n└ Add a CSV export to the reports page.⏎ Acceptance: …",
  );
  assert.equal(delegateCall({ kind: "review", title: "Review", task: "", startFrom: "feature/x" }, plain), "delegate review Review from feature/x");
  // While the model still streams the arguments, some are missing.
  assert.equal(delegateCall({}, plain), "delegate  ");
});

test("model-written arguments cannot reach the terminal raw", () => {
  const call = delegateCall({ kind: "implement", title: "\x1b[2Jwipe\x1b]0;x\x07", task: "a‮b" }, plain);
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f‮]/.test(call), JSON.stringify(call));
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(workerCall({ action: "message", id: "x\x1b[31m", message: "hi\x07" }, plain)));
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(cleanLines("one\x1b[31m\ntwo\x07")));
  assert.equal(cleanLines("one\ntwo"), "one\ntwo");
  assert.match(cleanLines(Array.from({ length: 45 }, (_, i) => `l${i}`).join("\n")), /… 5 more lines$/);
});

test("a delegate result says started or queued, with the route", () => {
  const started: StartResult = { status: "started", worker: worker(), text: "Delegated…" };
  assert.equal(
    delegateResult(started, "Delegated…", false, paint),
    "<accent>●</accent> started · standard · gpt-6-sol (high) · in a background Herdr tab",
  );
  assert.equal(delegateResult(started, "Delegated…", true, plain), "● started · standard · gpt-6-sol (high) · in a background Herdr tab\nDelegated…");
  const queued: StartResult = { status: "queued", worker: worker({ state: "queued" }), text: "q" };
  assert.match(delegateResult(queued, "q", false, plain), /^○ queued · standard/);
  const notReady: StartResult = { status: "not_ready", missing: ["acceptance"], text: "Not delegated: no acceptance criteria." };
  assert.equal(delegateResult(notReady, notReady.text, false, paint), "<warning>?</warning> Not delegated: no acceptance criteria.");
  const failed: StartResult = { status: "failed", text: "PI Lead workers need Herdr." };
  assert.equal(delegateResult(failed, failed.text, false, paint), "<error>✗</error> PI Lead workers need Herdr.");
  // A result stored by another version: its text only.
  assert.equal(delegateResult(undefined, "old text", false, plain), "old text");
});

test("worker calls name the action and target; list results are rows with the state glyph", () => {
  assert.equal(workerCall({ action: "list" }, plain), "worker list");
  assert.equal(workerCall({ action: "stop", id: "a1b2" }, paint), "<toolTitle>worker </toolTitle>stop <accent>a1b2</accent>");
  assert.equal(workerCall({ action: "message", id: "Dates", message: "ISO 8601" }, plain), "worker message Dates\n└ ISO 8601");
  assert.equal(
    workerResult({ workers: [worker(), worker({ id: "9f8e7d6c5b4a", title: "auth flow", kind: "review", state: "waiting", verdict: "needs_human" })] }, "", paint),
    [
      "<accent>●</accent> Add CSV export  a1b2c3d4  implement · running · gpt-6-sol (high)",
      "<warning>?</warning> auth flow  9f8e7d6c  review · waiting · gpt-6-sol (high)",
    ].join("\n"),
  );
  assert.equal(workerResult({ workers: [] }, "No workers.", plain), "No workers.");
  assert.equal(workerResult(undefined, 'Sent to "Dates".', plain), 'Sent to "Dates".');
});
