import { providerOf } from "./quota.ts";

/** Pi's thinking levels (`--thinking`); Pi clamps a level to what the model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelRef = { provider: string; id: string };
/** The model and thinking level a worker runs on, as `--model` and `--thinking` take them. */
export type WorkerRoute = { model: string; thinking: ThinkingLevel };

export const modelName = (ref: ModelRef) => `${ref.provider}/${ref.id}`;

/** What a session offers a worker: the Lead's own model and thinking level, and every model Pi can use now. */
export type ModelChoice = { lead: ModelRef | undefined; thinking: ThinkingLevel; available: readonly ModelRef[] };

/** `~14:05` while a provider's quota is exhausted, undefined otherwise. */
export type QuotaBack = (provider: string) => string | undefined;

/** The Lead's model first, then the others; an exhausted provider's models say until when. */
export function modelList(choice: ModelChoice, back: QuotaBack): string {
  const lead = choice.lead ? modelName(choice.lead) : undefined;
  const names = [...new Set([...(lead ? [lead] : []), ...choice.available.map(modelName)])];
  return names
    .map((name) => {
      const until = back(providerOf(name));
      const notes = [...(name === lead ? ["yours"] : []), ...(until ? [`quota exhausted until ${until}`] : [])];
      return notes.length ? `${name} (${notes.join(", ")})` : name;
    })
    .join(", ");
}

/**
 * The worker's route: the requested model and thinking level, each defaulting
 * to the Lead's own. A model Pi cannot use now (unknown, no auth, or its
 * provider's quota exhausted) is refused with the list to choose from.
 */
export function chooseRoute(request: { model?: string; thinking?: ThinkingLevel }, choice: ModelChoice, back: QuotaBack): WorkerRoute | { error: string } {
  const lead = choice.lead ? modelName(choice.lead) : undefined;
  const model = request.model?.trim() || lead;
  const list = () => modelList(choice, back) || "none";
  if (request.thinking !== undefined && !THINKING_LEVELS.includes(request.thinking)) {
    return { error: `thinking must be one of ${THINKING_LEVELS.join(", ")}` };
  }
  if (!model) return { error: `the Lead has no model: pass \`model\`, one of: ${list()}` };
  const known = model === lead || choice.available.some((ref) => modelName(ref) === model);
  if (!known) return { error: `${model} is not a model Pi can use now. Available: ${list()}` };
  const until = back(providerOf(model));
  if (until) return { error: `the quota of ${providerOf(model)} is exhausted until ${until}. Available: ${list()}` };
  return { model, thinking: request.thinking ?? choice.thinking };
}
