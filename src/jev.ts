import { choice, noul, score, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

import type { LeadConfig, Tier } from "./config.ts";

/**
 * Jev answers closed-set questions; this module maps each answer to a
 * deterministic action. Every judgment returns `undefined` when Jev is not
 * configured, failing or unsure, and callers then fall back to a
 * documented default or ask the human.
 */

export type WorkKind = "implement" | "prototype" | "debug" | "review" | "research";
export type WorkerVerdict = "done" | "partial" | "blocked" | "needs_human";
export type TierJudgment = { tier: Tier; difficulty: number };

/**
 * What a Jev call was about. Older versions also judged `egress`, `review`
 * severity, `failure` kind and ticket `overlap`; their stored decisions still render.
 */
export const JEV_KINDS = ["tier", "verdict"] as const;
export type JevKind = (typeof JEV_KINDS)[number];

/**
 * One judgment, for display only. `jev`: Jev's answer was applied; `fallback`:
 * Jev was unsure or failing and a default applied; `overridden`:
 * Jev's answer replaced the worker's (a more pessimistic verdict). Every text
 * field is built here from closed labels.
 */
export type JevDecision = {
  kind: JevKind;
  outcome: string;
  applied: "jev" | "fallback" | "overridden";
  /** Of a choice or score answer. */
  confidence?: number;
  /** Of a yes/no answer (stored by older versions' overlap judgment). */
  probability?: number;
  detail?: string;
  at: number;
};

export type Judge = {
  readonly available: boolean;
  modelTier(input: { task: string; kind: WorkKind }): Promise<TierJudgment | undefined>;
  verdict(input: {
    task: string;
    reported: WorkerVerdict;
    summary: string;
    diffStat: string;
    /** `git log --oneline base..branch`, collected on the host. */
    commits: string;
    /** Changed paths since `base` (`Workspace.collect`), collected on the host. */
    changedFiles: string[];
  }): Promise<WorkerVerdict | undefined>;
};

/** Minimal shape of `TypeSafeClient.systemOne`, injectable for tests. */
export type AskJev = (
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ answers: Record<string, unknown> }>;

// ---- deterministic mappings (pure, tested) --------------------------------

const clip = (text: string, max = 12_000) => (text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text);

/** Difficulty rubric: 0 trivial … 4 hard. */
export const DIFFICULTY_RUBRIC = [
  "Trivial: a one-line or mechanical change, rename, copy edit or config tweak.",
  "Easy: a small, local change in one module with an obvious approach.",
  "Moderate: a feature slice touching a few modules with tests to write.",
  "Hard: cross-cutting change, subtle logic, concurrency, security or performance work.",
  "Very hard: architectural change, ambiguous requirements, or deep debugging.",
] as const;

/** The tier used when Jev gives no difficulty, whatever the kind of work. */
export const DEFAULT_TIER: Tier = "standard";

/** Least to most pessimistic; the Lead trusts the more pessimistic of the worker and Jev. */
export const VERDICT_ORDER: readonly WorkerVerdict[] = ["done", "partial", "blocked", "needs_human"];

export function tierForDifficulty(difficulty: number, kind: WorkKind): Tier {
  // Review and debugging read more than they write; never send them to the fast tier.
  const floor: Tier = kind === "debug" || kind === "review" ? "standard" : "fast";
  const tier: Tier = difficulty < 1.5 ? "fast" : difficulty < 2.8 ? "standard" : "deep";
  const order: Tier[] = ["fast", "standard", "deep"];
  return order[Math.max(order.indexOf(floor), order.indexOf(tier))]!;
}

/** Map a yes-probability to a three-way decision with an uncertainty band. */
export function band(probability: number, low = 0.2, high = 0.8): "yes" | "no" | "unsure" {
  if (probability >= high) return "yes";
  if (probability <= low) return "no";
  return "unsure";
}

/** Criteria past this are not asked about: a long checklist is cut, not skipped. */
export const MAX_CRITERIA = 8;

const CRITERIA_HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*)?acceptance criteria\b[\s:*]*$/i;
const LIST_ITEM = /^[-*]\s+(?:\[[ xX]\]\s+)?(\S.*)$/;
const TASK_ITEM = /^[-*]\s+\[[ xX]\]\s+(\S.*)$/;

/**
 * The ticket's acceptance criteria, when it has a checklist in the shapes
 * to-tickets writes: the top-level items under an "Acceptance criteria"
 * heading, or, without that heading, its top-level `- [ ]` items. Nothing is
 * extracted by a model: a ticket without such a list gets `[]`.
 */
export function acceptanceCriteria(ticket: string): string[] {
  const lines = ticket.split(/\r?\n/);
  const heading = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  const items: string[] = [];
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      if (/^\s*#{1,6}\s/.test(line)) break;
      const item = LIST_ITEM.exec(line);
      if (item) items.push(item[1]!.trim());
      // Indented lines continue an item; other text after the list ends it.
      else if (items.length > 0 && line.trim() && !/^\s/.test(line)) break;
    }
  } else {
    for (const line of lines) {
      const item = TASK_ITEM.exec(line);
      if (item) items.push(item[1]!.trim());
    }
  }
  return items.slice(0, MAX_CRITERIA).map((item) => clip(item, 500));
}

// ---- answer validation ----------------------------------------------------

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function noulOf(answer: unknown): number | undefined {
  const value = (answer as { noul?: unknown } | undefined)?.noul;
  return isProbability(value) ? value : undefined;
}

function choiceOf<T extends string>(answer: unknown, labels: readonly T[], minConfidence: number): T | undefined {
  const { choice: selected, confidence } = (answer ?? {}) as { choice?: unknown; confidence?: unknown };
  if (!labels.includes(selected as T) || !isProbability(confidence) || confidence < minConfidence) return undefined;
  return selected as T;
}

function scoreOf(answer: unknown, levels: number, minConfidence: number): number | undefined {
  const { score: value, confidence } = (answer ?? {}) as { score?: unknown; confidence?: unknown };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > levels - 1) return undefined;
  if (!isProbability(confidence) || confidence < minConfidence) return undefined;
  return value;
}

const DIFFICULTY_QUESTION = "How hard is this engineering task for a coding agent?";

function tierOf(answer: unknown, kind: WorkKind, minConfidence: number): TierJudgment | undefined {
  const difficulty = scoreOf(answer, DIFFICULTY_RUBRIC.length, minConfidence);
  return difficulty === undefined ? undefined : { tier: tierForDifficulty(difficulty, kind), difficulty };
}

// ---- judge ----------------------------------------------------------------

/** One line for the user; `message` is already clipped and free of the key. */
export function describeJevProblem(message: string): string {
  return `Jev is configured but failing (${message}); PI Lead falls back to its defaults.`;
}

type Call = { answers?: Record<string, unknown>; failed?: true };
type DecisionInput = Omit<JevDecision, "at">;

export function createJudge(options: {
  ask?: AskJev;
  config: LeadConfig["jev"];
  /** Called at most once per judge, on the first failure. */
  onProblem?: (message: string) => void;
  /** Called once per judgment Jev was asked for (not for cached answers, nor when Jev is not configured). */
  onDecision?: (decision: JevDecision) => void;
}): Judge {
  const { ask, config, onProblem, onDecision } = options;
  let reported = false;
  const report = (message: string) => {
    if (reported) return;
    reported = true;
    try {
      onProblem?.(message);
    } catch {
      // A broken notifier must not turn a fallback into a crash.
    }
  };

  /** For a fallback, `outcome` names the default that applies; the reason is prefixed here. */
  const emit = (call: Call | undefined, decision: DecisionInput) => {
    if (!call || !onDecision) return;
    const outcome = decision.applied === "fallback" ? `${call.failed ? "failing" : "unsure"} → ${decision.outcome}` : decision.outcome;
    try {
      onDecision({ ...decision, outcome, at: Date.now() });
    } catch {
      // Display only: never let it change a decision.
    }
  };

  const run = async (state: unknown, questions: Record<string, unknown>): Promise<Call | undefined> => {
    if (!ask) return undefined;
    try {
      return { answers: (await ask(state, questions, AbortSignal.timeout(15_000))).answers };
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "unknown error";
      report(text.length > 200 ? `${text.slice(0, 200)}…` : text);
      return { failed: true };
    }
  };

  const confidence = (answer: unknown) => {
    const value = (answer as { confidence?: unknown } | undefined)?.confidence;
    return isProbability(value) ? { confidence: value } : {};
  };

  const tierDecision = (answer: unknown, judged: TierJudgment | undefined): DecisionInput => ({
    kind: "tier",
    outcome: judged ? judged.tier : DEFAULT_TIER,
    applied: judged ? "jev" : "fallback",
    ...confidence(answer),
    ...(judged ? { detail: `difficulty ${judged.difficulty.toFixed(1)}/4` } : {}),
  });

  return {
    available: ask !== undefined,

    async modelTier({ task, kind }) {
      const call = await run({ kind, task: clip(task) }, { difficulty: score(DIFFICULTY_QUESTION, DIFFICULTY_RUBRIC) });
      const judged = tierOf(call?.answers?.difficulty, kind, config.minConfidence);
      emit(call, tierDecision(call?.answers?.difficulty, judged));
      return judged;
    },

    async verdict({ task, reported, summary, diffStat, commits, changedFiles }) {
      const labels = ["done", "partial", "blocked", "needs_human"] as const;
      const criteria = acceptanceCriteria(task);
      const questions: Record<string, unknown> = {
        verdict: choice("Given the ticket, the worker's report and the evidence (commits, changed files), what is the real state of the work?", {
          done: "The ticket's acceptance criteria are met and verified.",
          partial: "Useful progress, but some acceptance criteria are not met or not verified.",
          blocked: "The worker could not proceed because of a technical obstacle.",
          needs_human: "A human decision, credential or manual step is required.",
        }),
      };
      criteria.forEach((criterion, index) => {
        questions[`criterion${index + 1}`] = noul(`Does the evidence show this criterion met? ${criterion}`, {
          true: "The commits, changed files or test run show it met.",
          false: "The evidence shows it unmet, or shows no work towards it.",
        });
      });
      const call = await run(
        {
          ticket: clip(task, 6_000),
          workerSaid: reported,
          summary: clip(summary, 6_000),
          commits: clip(commits, 3_000),
          changedFiles: clip(changedFiles.join("\n"), 3_000),
          diffStat: clip(diffStat, 3_000),
        },
        questions,
      );
      const answers = call?.answers;
      const verdict = choiceOf(answers?.verdict, labels, config.minConfidence);
      const unmet = criteria.flatMap((_, index) => {
        const probability = noulOf(answers?.[`criterion${index + 1}`]);
        return probability !== undefined && band(probability) === "no" ? [index + 1] : [];
      });
      // An unmet criterion makes Jev's verdict at most partial; blocked and needs_human stand.
      const final = unmet.length > 0 && (verdict === undefined || verdict === "done") ? "partial" : verdict;
      const unmetDetail = unmet.length ? `${unmet.length > 1 ? "criteria" : "criterion"} ${unmet.join(", ")} not met` : undefined;
      const common = { kind: "verdict" as const, ...confidence(answers?.verdict) };
      if (final === undefined) emit(call, { ...common, outcome: `${reported} stands`, applied: "fallback" });
      else if (VERDICT_ORDER.indexOf(final) > VERDICT_ORDER.indexOf(reported)) {
        emit(call, { ...common, outcome: `${reported} → ${final}`, applied: "overridden", ...(unmetDetail ? { detail: unmetDetail } : {}) });
      } else {
        const detail = [final !== reported ? `worker's ${reported} kept` : undefined, unmetDetail].filter(Boolean).join(", ");
        emit(call, { ...common, outcome: final, applied: "jev", ...(detail ? { detail } : {}) });
      }
      return final;
    },
  };
}

/** Build the real System One caller, or `undefined` when no key is configured. */
export function createAskJev(
  config: LeadConfig["jev"],
  environment: NodeJS.ProcessEnv = process.env,
  fetch?: Fetch,
): AskJev | undefined {
  const apiKey = environment[config.apiKeyEnv]?.trim();
  if (!apiKey) return undefined;
  const client = new TypeSafeClient({
    apiKey,
    ...(config.via === "openrouter" ? { baseURL: "https://openrouter.ai/api" } : {}),
    defaultModel: config.model,
    logLevel: "off",
    timeout: 5_000,
    retry: { maxRetries: 1 },
    ...(fetch ? { fetch } : {}),
  });
  return async (state, questions, signal) => {
    const result = await client
      .systemOne({ state: state as never, questions: questions as never }, { ...(signal ? { signal } : {}) })
      .catch((error: unknown) => {
        // Errors reach the user's screen: never let one carry the key.
        throw new Error((error instanceof Error ? error.message : String(error)).split(apiKey).join("[redacted]"));
      });
    return { answers: result.answers as Record<string, unknown> };
  };
}
