/**
 * Provider errors that mean "your included allowance is used up", as Pi
 * reports them after giving up on a turn. Pi never retries these (see
 * `pi-ai/dist/utils/retry.js`); ChatGPT's own wording is "You have hit your
 * ChatGPT usage limit (pro plan). Try again in ~N min."
 */
const QUOTA_ERROR =
  /usage.?limit|GoUsageLimitError|FreeUsageLimitError|available balance|usage_not_included|insufficient_quota|out of budget|quota exceeded|billing/i;

export type QuotaError = { message: string; retryAfterMinutes?: number };

export function quotaError(errorMessage: string): QuotaError | undefined {
  if (!QUOTA_ERROR.test(errorMessage)) return undefined;
  const minutes = /try again in ~?\s*(\d+)\s*min/i.exec(errorMessage)?.[1];
  return { message: errorMessage.slice(0, 500), ...(minutes ? { retryAfterMinutes: Number(minutes) } : {}) };
}

/** Never shorter: "Try again in ~0 min" must not relaunch the same model at once. */
export const MIN_QUOTA_PAUSE_MINUTES = 5;
/** How long a provider is skipped when it does not say when its quota resets. */
export const DEFAULT_QUOTA_PAUSE_MINUTES = 60;

/**
 * Minutes to route around a provider after a quota error. Pi turns every
 * ChatGPT 429 into the same "usage limit" text; without a reset time it may
 * be a short rate limit rather than the plan's allowance, so it gets the
 * short pause.
 */
export function quotaPauseMinutes(quota: QuotaError): number {
  if (quota.retryAfterMinutes !== undefined) return Math.max(quota.retryAfterMinutes, MIN_QUOTA_PAUSE_MINUTES);
  return /ChatGPT usage limit/i.test(quota.message) ? MIN_QUOTA_PAUSE_MINUTES : DEFAULT_QUOTA_PAUSE_MINUTES;
}

/** `openai-codex/gpt-6-sol` → `openai-codex`. */
export const providerOf = (model: string) => model.split("/")[0]!;
