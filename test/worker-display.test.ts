import assert from "node:assert/strict";
import { test } from "node:test";

import { attentionNotice, plainTitle, renderProgress, stateGlyph, stateLabels, tabLabel, workerCounts, type WorkerView } from "../src/worker-display.ts";

const worker = (overrides: Partial<WorkerView> = {}): WorkerView => ({ kind: "implement", title: "Add CSV export", state: "running", ...overrides });
const route = { model: "openai-codex/gpt-6-sol", thinking: "high" };

test("each state has its own one-column glyph, and a waiting worker says why it waits", () => {
  assert.deepEqual(
    (["queued", "starting", "running", "done", "failed", "stopped"] as const).map((state) => stateGlyph({ state })),
    ["○", "○", "●", "✓", "✗", "-"],
  );
  assert.equal(stateGlyph({ state: "waiting", verdict: "needs_human" }), "?");
  assert.equal(stateGlyph({ state: "waiting", verdict: "partial" }), "~");
  assert.equal(stateGlyph({ state: "waiting", verdict: "blocked" }), "✗");
  assert.equal(stateGlyph({ state: "waiting" }), "?", "a worker waiting for an unknown reason still waits on the user");
});

test("titles reaching Herdr keep letters and plain punctuation only", () => {
  assert.equal(plainTitle("Export CSV des réservations"), "Export CSV des réservations");
  assert.equal(plainTitle("Fix $(whoami) `rm` bug"), "Fix (whoami) rm bug");
  assert.equal(plainTitle("evil\x1b]0;pwned\x07 title"), "evil 0 pwned title");
  assert.equal(plainTitle("rtl‮txt.exe zero​width"), "rtl txt.exe zero width");
  assert.equal(plainTitle("🔨 ship 界 it"), "ship it");
  assert.equal(plainTitle("   "), "worker");
  assert.equal(plainTitle("--help me"), "help me", "never read as a flag");
  assert.equal(plainTitle("---"), "worker");
  const long = plainTitle("A very long title that goes on and on and on");
  assert.ok([...long].length <= 32);
  assert.ok(long.endsWith("…"));
});

test("the tab label is the state glyph and the clean title", () => {
  assert.equal(tabLabel(worker({ state: "starting" })), "○ Add CSV export");
  assert.equal(tabLabel(worker({ state: "waiting", verdict: "needs_human", title: "Dates\n$(id)" })), "? Dates (id)");
});

test("Herdr state labels are host strings: kind and route while working, the reason once idle", () => {
  assert.deepEqual(stateLabels(worker(), route), { working: "implement · gpt-6-sol · high", idle: "idle", blocked: "asks you in its tab" });
  assert.equal(stateLabels(worker({ state: "waiting", verdict: "needs_human" }), route).blocked, "needs your answer");
  assert.equal(stateLabels(worker({ state: "waiting", verdict: "needs_human" }), route).idle, "needs your answer");
  assert.equal(stateLabels(worker({ state: "waiting", verdict: "partial" }), route).idle, "partly done, needs you");
  assert.equal(stateLabels(worker({ state: "done", verdict: "done" }), route).idle, "done");
});

test("only a worker that needs the user raises a toast, and only a question rings", () => {
  assert.equal(attentionNotice(worker()), undefined);
  assert.equal(attentionNotice(worker({ state: "done", verdict: "done" })), undefined);
  assert.equal(attentionNotice(worker({ state: "stopped" })), undefined);
  assert.deepEqual(attentionNotice(worker({ state: "waiting", verdict: "needs_human" })), { title: "? Add CSV export: needs your answer", sound: "request" });
  assert.deepEqual(attentionNotice(worker({ state: "waiting", verdict: "blocked" })), { title: "✗ Add CSV export: blocked, needs you", sound: "none" });
  assert.deepEqual(attentionNotice(worker({ state: "failed" })), { title: "✗ Add CSV export: failed", sound: "none" });
  // keepFailedWorkers off: the tab is closed, but the finish was still a question.
  assert.deepEqual(attentionNotice(worker({ state: "failed", verdict: "needs_human" })), { title: "✗ Add CSV export: needs your answer", sound: "request" });
});

test("the footer only counts live workers", () => {
  assert.equal(workerCounts([]), undefined);
  assert.equal(workerCounts([{ state: "done" }, { state: "stopped" }, { state: "failed" }]), undefined);
  assert.deepEqual(workerCounts([{ state: "running" }, { state: "starting" }, { state: "queued" }, { state: "waiting" }]), {
    text: "● 2 running · 1 queued · 1 needs you",
    needsYou: true,
  });
  assert.deepEqual(workerCounts([{ state: "queued" }]), { text: "● 1 queued", needsYou: false });
});

test("progress lines fit the width and replace what could be wider than one column", () => {
  assert.equal(renderProgress('"Réservations" started on openai-codex/gpt-6-sol (high)', 80), '→ "Réservations" started on openai-codex/gpt-6-sol (high)');
  assert.equal(renderProgress("界 \x1b[31mred", 80), "→ ? ?[31mred");
  assert.equal(renderProgress(42, 80), "→ ");
  assert.equal(renderProgress("Re\u0301servations", 80), "→ Réservations", "decomposed accents are composed first");
  assert.equal(renderProgress("x", 0), "");
  const fitted = renderProgress("x".repeat(100), 20);
  assert.equal([...fitted].length, 20);
  assert.ok(fitted.endsWith("…"));
});
