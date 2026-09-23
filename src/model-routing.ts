import type { LeadConfig, ThinkingLevel, Tier } from "./config.ts";

export type ModelRef = { provider: string; id: string };
export type WorkerRoute = { model: string; thinking: ThinkingLevel; tier: Tier; note?: string };

const refToString = (ref: ModelRef) => `${ref.provider}/${ref.id}`;

/**
 * Map a tier to a concrete, currently available model. A configured model
 * that is not available degrades to the Lead's own model rather than failing,
 * and says so.
 */
export function resolveRoute(
  tier: Tier,
  tiers: LeadConfig["tiers"],
  lead: ModelRef | undefined,
  available: readonly ModelRef[],
): WorkerRoute | { error: string } {
  const configured = tiers[tier];
  if (configured.model) {
    const match = available.find((model) => refToString(model) === configured.model);
    if (match) return { model: configured.model, thinking: configured.thinking, tier };
    if (!lead) return { error: `model ${configured.model} for tier ${tier} is not available and the Lead has no model` };
    return {
      model: refToString(lead),
      thinking: configured.thinking,
      tier,
      note: `${configured.model} is not available; using the Lead's model`,
    };
  }
  if (!lead) return { error: `no model configured for tier ${tier} and the Lead has no model` };
  return { model: refToString(lead), thinking: configured.thinking, tier };
}
