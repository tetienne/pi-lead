import type { LeadConfig, ThinkingLevel, Tier } from "./config.ts";

export type ModelRef = { provider: string; id: string };
export type WorkerRoute = { model: string; thinking: ThinkingLevel; tier: Tier; note?: string };

const refToString = (ref: ModelRef) => `${ref.provider}/${ref.id}`;

/**
 * Map a tier to a concrete, currently available model: the configured model,
 * then each fallback in order. When none is available the worker degrades to
 * the Lead's own model rather than failing, and says so.
 */
export function resolveRoute(
  tier: Tier,
  tiers: LeadConfig["tiers"],
  lead: ModelRef | undefined,
  available: readonly ModelRef[],
): WorkerRoute | { error: string } {
  const configured = tiers[tier];
  if (!configured.model) {
    if (!lead) return { error: `no model configured for tier ${tier} and the Lead has no model` };
    return { model: refToString(lead), thinking: configured.thinking, tier };
  }
  const candidates = [
    { model: configured.model, thinking: configured.thinking },
    ...(configured.fallbacks ?? []).map((fallback) => ({ model: fallback.model, thinking: fallback.thinking ?? configured.thinking })),
  ];
  const isAvailable = (model: string) => available.some((ref) => refToString(ref) === model);
  const index = candidates.findIndex((candidate) => isAvailable(candidate.model));
  const skipped = candidates.slice(0, index === -1 ? candidates.length : index).map((candidate) => candidate.model);
  const unavailable = `${skipped.join(", ")} ${skipped.length > 1 ? "are" : "is"} not available`;
  if (index === 0) return { ...candidates[0]!, tier };
  if (index > 0) return { ...candidates[index]!, tier, note: `${unavailable}; using ${candidates[index]!.model}` };
  if (!lead) return { error: `${unavailable} for tier ${tier} and the Lead has no model` };
  return { model: refToString(lead), thinking: configured.thinking, tier, note: `${unavailable}; using the Lead's model` };
}
