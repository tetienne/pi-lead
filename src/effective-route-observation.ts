import {
  PI_REASONING_LEVELS,
  type EffectivePiRoute,
  type PiReasoningLevel,
} from "./model-reasoning-routing.ts";
import { isRecord } from "./state-files.ts";

export function parseEffectivePiRoute(
  value: unknown,
  provider: EffectivePiRoute["provider"],
  label: string,
): EffectivePiRoute {
  if (!isRecord(value) || !isRecord(value.effectiveRoute)) {
    throw new Error(`Invalid ${label} route observation`);
  }
  const route = value.effectiveRoute;
  const modelId = route.modelId;
  const reasoning = route.reasoning;
  if (
    route.provider !== provider || typeof modelId !== "string" || !modelId || modelId.length > 160 ||
    typeof reasoning !== "string" || !(PI_REASONING_LEVELS as readonly string[]).includes(reasoning)
  ) {
    throw new Error(`Invalid ${label} route observation`);
  }
  return { provider, modelId, reasoning: reasoning as PiReasoningLevel };
}
