import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { choice, noul, score, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

import type { LeadConfig, Tier } from "./config.ts";

/**
 * Jev answers closed-set questions; this module maps each answer to a
 * deterministic action. Every judgment returns `undefined` when Jev is not
 * configured, over budget, failing or unsure, and callers then fall back to a
 * documented default or ask the human.
 */

export type WorkKind = "implement" | "debug" | "review" | "research";
export type WorkerVerdict = "done" | "partial" | "blocked" | "needs_human";
export type FailureKind = "transient" | "environment" | "task_bug" | "needs_info";
export type ReviewAction = "none" | "auto_fix" | "escalate";
export type EgressDecision = "allow" | "deny" | "ask";

export type Judge = {
  readonly available: boolean;
  modelTier(input: { task: string; kind: WorkKind }): Promise<{ tier: Tier; difficulty: number } | undefined>;
  readiness(task: string): Promise<{ ready: boolean; missing: string[] } | undefined>;
  egress(input: { task: string; method: string; url: string }): Promise<EgressDecision>;
  verdict(input: {
    task: string;
    reported: WorkerVerdict;
    summary: string;
    diffStat: string;
  }): Promise<WorkerVerdict | undefined>;
  reviewSeverity(findings: string): Promise<{ severity: number; action: ReviewAction } | undefined>;
  failureKind(input: { task: string; log: string }): Promise<FailureKind | undefined>;
  overlap(a: string, b: string): Promise<boolean | undefined>;
};

/** Minimal shape of `TypeSafeClient.systemOne`, injectable for tests. */
export type AskJev = (
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ answers: Record<string, unknown>; inputTokens: number }>;

// ---- deterministic mappings (pure, tested) --------------------------------

/** Difficulty rubric: 0 trivial … 4 hard. */
export const DIFFICULTY_RUBRIC = [
  "Trivial: a one-line or mechanical change, rename, copy edit or config tweak.",
  "Easy: a small, local change in one module with an obvious approach.",
  "Moderate: a feature slice touching a few modules with tests to write.",
  "Hard: cross-cutting change, subtle logic, concurrency, security or performance work.",
  "Very hard: architectural change, ambiguous requirements, or deep debugging.",
] as const;

export function tierForDifficulty(difficulty: number, kind: WorkKind): Tier {
  // Review and debugging read more than they write; never send them to the
  // fast tier.
  const floor: Tier = kind === "implement" || kind === "research" ? "fast" : "standard";
  const tier: Tier = difficulty < 1.5 ? "fast" : difficulty < 2.8 ? "standard" : "deep";
  const order: Tier[] = ["fast", "standard", "deep"];
  return order[Math.max(order.indexOf(floor), order.indexOf(tier))]!;
}

export const SEVERITY_RUBRIC = [
  "No findings, or only praise.",
  "Nits only: naming, formatting, comments.",
  "Minor issues: small bugs or gaps with an obvious local fix.",
  "Major issues: incorrect behaviour, missing tests for key paths, or spec mismatch.",
  "Critical issues: security, data loss, or the change does not do what was asked.",
] as const;

export function actionForSeverity(severity: number): ReviewAction {
  if (severity < 1.5) return "none";
  if (severity < 3) return "auto_fix";
  return "escalate";
}

/** Map a yes-probability to a three-way decision with an uncertainty band. */
export function band(probability: number, low = 0.2, high = 0.8): "yes" | "no" | "unsure" {
  if (probability >= high) return "yes";
  if (probability <= low) return "no";
  return "unsure";
}

// ---- budget ---------------------------------------------------------------

type Ledger = { day: string; usd: number };

/** File-backed so the Lead and every worker share one daily budget. */
export function createLedger(path = join(homedir(), ".pi", "agent", "pi-lead", "jev-usage.json")) {
  const today = () => new Date().toISOString().slice(0, 10);
  const read = async (): Promise<Ledger> => {
    try {
      const ledger = JSON.parse(await readFile(path, "utf8")) as Ledger;
      return ledger.day === today() && Number.isFinite(ledger.usd) ? ledger : { day: today(), usd: 0 };
    } catch {
      return { day: today(), usd: 0 };
    }
  };
  return {
    spent: async () => (await read()).usd,
    async charge(usd: number) {
      const ledger = await read();
      ledger.usd += usd;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(ledger));
      await rename(temporary, path);
    },
  };
}

export type Ledgerish = ReturnType<typeof createLedger>;

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

// ---- judge ----------------------------------------------------------------

const clip = (text: string, max = 12_000) => (text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text);

export function createJudge(options: {
  ask?: AskJev;
  config: LeadConfig["jev"];
  ledger: Ledgerish;
}): Judge {
  const { ask, config, ledger } = options;
  const egressCache = new Map<string, EgressDecision>();

  const run = async (state: unknown, questions: Record<string, unknown>) => {
    if (!ask) return undefined;
    try {
      if ((await ledger.spent()) >= config.dailyBudgetUsd) return undefined;
      const result = await ask(state, questions, AbortSignal.timeout(15_000));
      await ledger.charge((result.inputTokens / 1_000_000) * config.inputUsdPerMillion);
      return result.answers;
    } catch {
      return undefined;
    }
  };

  return {
    available: ask !== undefined,

    async modelTier({ task, kind }) {
      const answers = await run(
        { kind, task: clip(task) },
        { difficulty: score("How hard is this engineering task for a coding agent?", DIFFICULTY_RUBRIC) },
      );
      const difficulty = scoreOf(answers?.difficulty, DIFFICULTY_RUBRIC.length, config.minConfidence);
      return difficulty === undefined ? undefined : { tier: tierForDifficulty(difficulty, kind), difficulty };
    },

    async readiness(task) {
      const checks = {
        acceptance: "Does the ticket state acceptance criteria that a test or command can verify?",
        bounded: "Is the scope one thin, bounded slice rather than several features or an open-ended goal?",
        decided: "Are all product and design decisions needed to start already made in the ticket?",
      } as const;
      const answers = await run(
        { ticket: clip(task) },
        Object.fromEntries(Object.entries(checks).map(([key, question]) => [key, noul(question)])),
      );
      if (!answers) return undefined;
      const missing: string[] = [];
      for (const key of Object.keys(checks) as (keyof typeof checks)[]) {
        const probability = noulOf(answers[key]);
        if (probability === undefined) return undefined;
        if (band(probability, 0.35, 0.65) === "no") missing.push(key);
      }
      return { ready: missing.length === 0, missing };
    },

    async egress({ task, method, url }) {
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        return "deny";
      }
      const key = `${method} ${host}`;
      const cached = egressCache.get(key);
      if (cached) return cached;
      const answers = await run(
        { ticket: clip(task, 4_000), request: { method, url: clip(url, 500) } },
        {
          needed: noul(
            "Is this network request plausibly needed to do the ticket (installing declared dependencies, fetching docs or sources it names)?",
            { true: "Needed for the ticket.", false: "Unrelated, exfiltration-like, or sending data somewhere the ticket does not need." },
          ),
        },
      );
      const probability = noulOf(answers?.needed);
      const decision: EgressDecision =
        probability === undefined ? "ask" : { yes: "allow", no: "deny", unsure: "ask" }[band(probability, 0.15, 0.85)] as EgressDecision;
      if (decision !== "ask") egressCache.set(key, decision);
      return decision;
    },

    async verdict({ task, reported, summary, diffStat }) {
      const labels = ["done", "partial", "blocked", "needs_human"] as const;
      const answers = await run(
        { ticket: clip(task, 6_000), workerSaid: reported, summary: clip(summary, 6_000), diffStat: clip(diffStat, 3_000) },
        {
          verdict: choice("Given the ticket and the worker's report, what is the real state of the work?", {
            done: "The ticket's acceptance criteria are met and verified.",
            partial: "Useful progress, but some acceptance criteria are not met or not verified.",
            blocked: "The worker could not proceed because of a technical obstacle.",
            needs_human: "A human decision, credential or manual step is required.",
          }),
        },
      );
      return choiceOf(answers?.verdict, labels, config.minConfidence);
    },

    async reviewSeverity(findings) {
      const answers = await run(
        { findings: clip(findings) },
        { severity: score("How severe are the most serious findings in this code review?", SEVERITY_RUBRIC) },
      );
      const severity = scoreOf(answers?.severity, SEVERITY_RUBRIC.length, config.minConfidence);
      return severity === undefined ? undefined : { severity, action: actionForSeverity(severity) };
    },

    async failureKind({ task, log }) {
      const labels = ["transient", "environment", "task_bug", "needs_info"] as const;
      const answers = await run(
        { ticket: clip(task, 4_000), failure: clip(log, 8_000) },
        {
          kind: choice("Why did this coding worker fail?", {
            transient: "A flaky network, rate limit, timeout or crash unrelated to the task; retrying may work.",
            environment: "Missing tool, dependency, image or permission in the sandbox.",
            task_bug: "The code or tests are genuinely wrong and need diagnosis.",
            needs_info: "The ticket is unclear or a human decision is missing.",
          }),
        },
      );
      return choiceOf(answers?.kind, labels, config.minConfidence);
    },

    async overlap(a, b) {
      const answers = await run(
        { first: clip(a, 5_000), second: clip(b, 5_000) },
        { overlap: noul("Would doing these two tickets in parallel likely edit the same files or the same behaviour?") },
      );
      const probability = noulOf(answers?.overlap);
      return probability === undefined ? undefined : probability >= 0.5;
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
    const result = await client.systemOne(
      { state: state as never, questions: questions as never },
      { ...(signal ? { signal } : {}) },
    );
    return { answers: result.answers as Record<string, unknown>, inputTokens: result.usage.input_tokens };
  };
}
