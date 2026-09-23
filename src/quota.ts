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

/** `openai-codex/gpt-6-sol` → `openai-codex`. */
export const providerOf = (model: string) => model.split("/")[0]!;
