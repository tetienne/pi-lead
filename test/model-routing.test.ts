import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseRoute, modelList, type ModelChoice } from "../src/model-routing.ts";

const lead = { provider: "anthropic", id: "claude-sonnet-5" };
const choice: ModelChoice = { lead, thinking: "medium", available: [lead, { provider: "openai-codex", id: "gpt-6-luna" }] };
const none = () => undefined;

test("omitted model and thinking run the worker on the Lead's own", () => {
  assert.deepEqual(chooseRoute({}, choice, none), { model: "anthropic/claude-sonnet-5", thinking: "medium" });
});

test("an available model and a thinking level are taken as given", () => {
  assert.deepEqual(chooseRoute({ model: "openai-codex/gpt-6-luna", thinking: "low" }, choice, none), { model: "openai-codex/gpt-6-luna", thinking: "low" });
});

test("a thinking level Pi does not know is refused", () => {
  assert.deepEqual(chooseRoute({ thinking: "extreme" as never }, choice, none), { error: "thinking must be one of off, minimal, low, medium, high, xhigh, max" });
});

test("a model Pi cannot use is refused with the list to choose from", () => {
  const refused = chooseRoute({ model: "openai-codex/gpt-6-astra" }, choice, none);
  assert.deepEqual(refused, {
    error: "openai-codex/gpt-6-astra is not a model Pi can use now. Available: anthropic/claude-sonnet-5 (yours), openai-codex/gpt-6-luna",
  });
});

test("an exhausted provider's models are listed with when they are back, and refused until then", () => {
  const back = (provider: string) => (provider === "openai-codex" ? "~14:05" : undefined);
  assert.equal(modelList(choice, back), "anthropic/claude-sonnet-5 (yours), openai-codex/gpt-6-luna (quota exhausted until ~14:05)");
  assert.match((chooseRoute({ model: "openai-codex/gpt-6-luna" }, choice, back) as { error: string }).error, /^the quota of openai-codex is exhausted until ~14:05\. Available: /);
  const leadOut = (provider: string) => (provider === "anthropic" ? "~09:30" : undefined);
  assert.match((chooseRoute({}, choice, leadOut) as { error: string }).error, /quota of anthropic is exhausted/, "the Lead's own model too");
});

test("without a Lead model a worker needs an explicit one", () => {
  assert.ok("error" in chooseRoute({}, { ...choice, lead: undefined }, none));
  assert.deepEqual(chooseRoute({ model: "anthropic/claude-sonnet-5" }, { ...choice, lead: undefined }, none), { model: "anthropic/claude-sonnet-5", thinking: "medium" });
});
