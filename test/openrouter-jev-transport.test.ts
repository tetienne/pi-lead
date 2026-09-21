import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpenRouterJevTransport } from "../src/openrouter-jev-transport.ts";

test("uses the official TypeSafe SDK native OpenRouter route with a bounded total deadline", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport = createOpenRouterJevTransport({
    apiKey: "dedicated-capped-key",
    timeoutMs: 1_000,
    totalDeadlineMs: 2_000,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        model: "jev-1.13",
        answers: {
          intent: {
            type: "choice",
            choice: "CHAT",
            confidence: 0.93,
            probabilities: { CHAT: 0.93, UNCERTAIN: 0.07 },
          },
        },
        usage: { input_tokens: 12, output_tokens: 3, cost: 0.001 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(await transport.decide({
    questionId: "intent",
    state: "summarize this project",
    candidates: ["CHAT", "UNCERTAIN"],
  }), {
    questionId: "intent",
    type: "choice",
    choice: "CHAT",
    confidence: 0.93,
    probabilities: { CHAT: 0.93, UNCERTAIN: 0.07 },
    costUsd: 0.001,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/systemone");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "jev-1.13",
    state: "summarize this project",
    questions: {
      intent: {
        type: "choice",
        instructions: "Select exactly one permitted workflow, or UNCERTAIN for mixed or ambiguous input.",
        criteria: { CHAT: null, UNCERTAIN: null },
      },
    },
  });
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer dedicated-capped-key");
});

test("rejects unbounded transport configuration and leaves absent provider cost evidence absent", async () => {
  assert.throws(
    () => createOpenRouterJevTransport({ apiKey: "key", timeoutMs: 1_001, totalDeadlineMs: 1_000 }),
    /total deadline/i,
  );
  const transport = createOpenRouterJevTransport({
    apiKey: "key",
    fetch: async () => new Response(JSON.stringify({
      model: "jev-1.13",
      answers: { intent: { type: "choice", choice: "CHAT", confidence: 1, probabilities: { CHAT: 1 } } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await transport.decide({ questionId: "intent", state: "x", candidates: ["CHAT"] });
  assert.equal((result as { costUsd?: unknown }).costUsd, undefined);
});
