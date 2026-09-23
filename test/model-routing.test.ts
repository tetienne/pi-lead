import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { resolveRoute } from "../src/model-routing.ts";

const lead = { provider: "anthropic", id: "claude-sonnet-5" };
const available = [lead, { provider: "openai-codex", id: "gpt-5.6-mini" }];

test("without configured models every tier uses the Lead's model with its thinking level", () => {
  assert.deepEqual(resolveRoute("fast", DEFAULT_CONFIG.tiers, lead, available), {
    model: "anthropic/claude-sonnet-5",
    thinking: "low",
    tier: "fast",
  });
  assert.equal((resolveRoute("deep", DEFAULT_CONFIG.tiers, lead, available) as { thinking: string }).thinking, "high");
});

test("a configured, available model is used", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { tiers: { fast: { model: "openai-codex/gpt-5.6-mini" } } });
  assert.deepEqual(resolveRoute("fast", config.tiers, lead, available), {
    model: "openai-codex/gpt-5.6-mini",
    thinking: "low",
    tier: "fast",
  });
});

test("an unavailable configured model degrades to the Lead's model and says so", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { tiers: { deep: { model: "openai-codex/gpt-6" } } });
  const route = resolveRoute("deep", config.tiers, lead, available);
  assert.ok("note" in route && route.model === "anthropic/claude-sonnet-5");
  assert.ok("error" in resolveRoute("deep", config.tiers, undefined, available));
});

test("an unavailable configured model falls back to the first available fallback, with its own thinking", () => {
  const config = mergeConfig(DEFAULT_CONFIG, {
    tiers: {
      standard: {
        model: "openai-codex/gpt-6-sol",
        thinking: "high",
        fallbacks: [{ model: "opencode-go/kimi-k3", thinking: "max" }, { model: "opencode-go/glm-5.3" }],
      },
    },
  });
  const withGo = [lead, { provider: "opencode-go", id: "glm-5.3" }];
  assert.deepEqual(resolveRoute("standard", config.tiers, lead, withGo), {
    model: "opencode-go/glm-5.3",
    thinking: "high",
    tier: "standard",
    note: "openai-codex/gpt-6-sol, opencode-go/kimi-k3 are not available; using opencode-go/glm-5.3",
  });
  const withCodex = [...withGo, { provider: "openai-codex", id: "gpt-6-sol" }];
  assert.deepEqual(resolveRoute("standard", config.tiers, lead, withCodex), {
    model: "openai-codex/gpt-6-sol",
    thinking: "high",
    tier: "standard",
  });
  const none = resolveRoute("standard", config.tiers, lead, [lead]);
  assert.ok("note" in none && none.model === "anthropic/claude-sonnet-5" && none.note?.endsWith("using the Lead's model"));
});

test("config merging keeps defaults for unspecified fields", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { sandbox: { image: "pi-lead:latest" }, jev: { dailyBudgetUsd: 0.5 } });
  assert.equal(config.sandbox.image, "pi-lead:latest");
  assert.deepEqual(config.sandbox.allowedHosts, DEFAULT_CONFIG.sandbox.allowedHosts);
  assert.equal(config.jev.dailyBudgetUsd, 0.5);
  assert.equal(config.jev.model, DEFAULT_CONFIG.jev.model);
});
