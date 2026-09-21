import { choice, type Fetch, TypeSafeClient } from "@typesafe-ai/sdk";

import type { JevIntentRequest, JevIntentTransport } from "./jev-intent-routing.ts";

const OPENROUTER_TYPESAFE_BASE_URL = "https://openrouter.ai/api";
const JEV_MODEL = "jev-1.13";

type OpenRouterJevTransportOptions = {
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
  totalDeadlineMs?: number;
};

function providerCost(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cost = (value as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * Host-only Jev transport. It deliberately exposes no ambient environment fallback:
 * callers must supply a dedicated, provider-capped OpenRouter key when live routing
 * is authorized.
 */
export function createOpenRouterJevTransport(
  options: OpenRouterJevTransportOptions,
): JevIntentTransport {
  if (!options.apiKey.trim()) throw new Error("Jev OpenRouter key is empty");
  const timeoutMs = options.timeoutMs ?? 3_000;
  const totalDeadlineMs = options.totalDeadlineMs ?? 7_000;
  if (
    !Number.isInteger(timeoutMs) ||
    !Number.isInteger(totalDeadlineMs) ||
    timeoutMs <= 0 ||
    totalDeadlineMs < timeoutMs
  ) {
    throw new Error("Jev total deadline must cover one bounded transport attempt");
  }
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: OPENROUTER_TYPESAFE_BASE_URL,
    defaultModel: JEV_MODEL,
    logLevel: "off",
    timeout: timeoutMs,
    retry: { maxRetries: 1 },
    fetch: options.fetch,
  });

  return {
    async decide(request, signal) {
      const deadline = AbortSignal.timeout(totalDeadlineMs);
      const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const criteria = Object.fromEntries(request.candidates.map((candidate) => [candidate, null]));
      const result = await client.systemOne({
        model: JEV_MODEL,
        state: request.state,
        questions: {
          intent: choice(
            "Select exactly one permitted workflow, or UNCERTAIN for mixed or ambiguous input.",
            criteria,
          ),
        },
      }, {
        signal: combinedSignal,
        timeout: timeoutMs,
        retry: { maxRetries: 1 },
      });
      const answer = result.answers.intent;
      return {
        questionId: request.questionId,
        type: answer.type,
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        // OpenRouter's optional cost evidence reaches the SDK's runtime value even
        // though the upstream SDK deliberately types Usage as token counts only.
        costUsd: providerCost((result.usage as unknown)),
      };
    },
  };
}
