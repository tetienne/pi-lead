import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { choice, noul, score, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

import type { LeadConfig, Tier } from "./config.ts";
import type { LastTest } from "./protocol.ts";

/**
 * Jev answers closed-set questions; this module maps each answer to a
 * deterministic action. Every judgment returns `undefined` when Jev is not
 * configured, over budget, failing or unsure, and callers then fall back to a
 * documented default or ask the human.
 */

export type WorkKind = "implement" | "prototype" | "debug" | "review" | "research";
export type WorkerVerdict = "done" | "partial" | "blocked" | "needs_human";
export type FailureKind = "transient" | "environment" | "task_bug" | "needs_info";
export type ReviewAction = "none" | "auto_fix" | "escalate";
export type EgressDecision = "allow" | "deny" | "ask";
export type TierJudgment = { tier: Tier; difficulty: number };
export type ReadinessJudgment = { ready: boolean; missing: string[] };

export type Judge = {
  readonly available: boolean;
  modelTier(input: { task: string; kind: WorkKind }): Promise<TierJudgment | undefined>;
  /**
   * Readiness (when asked) and difficulty in one Jev call. Each part is parsed
   * on its own: a malformed readiness answer leaves the tier intact, and vice versa.
   */
  intake(input: { task: string; kind: WorkKind; checkReadiness: boolean }): Promise<{
    readiness?: ReadinessJudgment;
    tier?: TierJudgment;
  }>;
  egress(input: { task: string; method: string; url: string }): Promise<EgressDecision>;
  verdict(input: {
    task: string;
    reported: WorkerVerdict;
    summary: string;
    diffStat: string;
    /** `git log --oneline base..branch`, collected on the host. */
    commits: string;
    /** Changed paths since `base` (`Workspace.collect`), collected on the host. */
    changedFiles: string[];
    /** Recorded outside the guest, but the guest controls what the command ran. */
    lastTest?: LastTest;
  }): Promise<WorkerVerdict | undefined>;
  reviewSeverity(findings: string): Promise<{ severity: number; action: ReviewAction } | undefined>;
  failureKind(input: { task: string; log: string }): Promise<FailureKind | undefined>;
  overlap(a: string, b: string): Promise<boolean | undefined>;
  /** Is a worker repeating the same failed approach? `undefined`: don't know. */
  stuck(input: { task: string; runs: readonly ShellRun[] }): Promise<boolean | undefined>;
};

/** A worker shell command as the host-side bash wrapper saw it. */
export type ShellRun = { command: string; exitCode: number; output?: string };

/** Minimal shape of `TypeSafeClient.systemOne`, injectable for tests. */
export type AskJev = (
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ answers: Record<string, unknown>; inputTokens: number }>;

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

export function tierForDifficulty(difficulty: number, kind: WorkKind): Tier {
  // Review and debugging read more than they write; never send them to the
  // fast tier.
  const floor: Tier = kind === "debug" || kind === "review" ? "standard" : "fast";
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

const READINESS_CHECKS = {
  acceptance: "Does the ticket state acceptance criteria that a test or command can verify?",
  bounded: "Is the scope one thin, bounded slice rather than several features or an open-ended goal?",
  decided: "Are all product and design decisions needed to start already made in the ticket?",
} as const;

const DIFFICULTY_QUESTION = "How hard is this engineering task for a coding agent?";

function readinessOf(answers: Record<string, unknown> | undefined): ReadinessJudgment | undefined {
  if (!answers) return undefined;
  const missing: string[] = [];
  for (const key of Object.keys(READINESS_CHECKS) as (keyof typeof READINESS_CHECKS)[]) {
    const probability = noulOf(answers[key]);
    if (probability === undefined) return undefined;
    if (band(probability, 0.35, 0.65) === "no") missing.push(key);
  }
  return { ready: missing.length === 0, missing };
}

function tierOf(answer: unknown, kind: WorkKind, minConfidence: number): TierJudgment | undefined {
  const difficulty = scoreOf(answer, DIFFICULTY_RUBRIC.length, minConfidence);
  return difficulty === undefined ? undefined : { tier: tierForDifficulty(difficulty, kind), difficulty };
}

// ---- judge ----------------------------------------------------------------

export type JevProblem = { kind: "error" | "budget"; message: string };

/** One line for the user; `message` is already clipped and free of the key. */
export function describeJevProblem(problem: JevProblem): string {
  return problem.kind === "budget"
    ? `${problem.message}; PI Lead falls back to its defaults until tomorrow.`
    : `Jev is configured but failing (${problem.message}); PI Lead falls back to its defaults.`;
}

export function createJudge(options: {
  ask?: AskJev;
  config: LeadConfig["jev"];
  ledger: Ledgerish;
  /** Called at most once per kind per judge: the first failure, the first time the budget is spent. */
  onProblem?: (problem: JevProblem) => void;
}): Judge {
  const { ask, config, ledger, onProblem } = options;
  const egressCache = new Map<string, EgressDecision>();
  const problemsSeen = new Set<JevProblem["kind"]>();
  const report = (kind: JevProblem["kind"], message: string) => {
    if (problemsSeen.has(kind)) return;
    problemsSeen.add(kind);
    try {
      onProblem?.({ kind, message });
    } catch {
      // A broken notifier must not turn a fallback into a crash.
    }
  };

  const run = async (state: unknown, questions: Record<string, unknown>) => {
    if (!ask) return undefined;
    try {
      if ((await ledger.spent()) >= config.dailyBudgetUsd) {
        report("budget", `Jev's daily budget ($${config.dailyBudgetUsd}) is spent`);
        return undefined;
      }
      const result = await ask(state, questions, AbortSignal.timeout(15_000));
      await ledger.charge((result.inputTokens / 1_000_000) * config.inputUsdPerMillion);
      return result.answers;
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "unknown error";
      report("error", text.length > 200 ? `${text.slice(0, 200)}…` : text);
      return undefined;
    }
  };

  return {
    available: ask !== undefined,

    async modelTier({ task, kind }) {
      const answers = await run({ kind, task: clip(task) }, { difficulty: score(DIFFICULTY_QUESTION, DIFFICULTY_RUBRIC) });
      return tierOf(answers?.difficulty, kind, config.minConfidence);
    },

    async intake({ task, kind, checkReadiness }) {
      const answers = await run(
        { kind, ticket: clip(task) },
        {
          ...(checkReadiness
            ? Object.fromEntries(Object.entries(READINESS_CHECKS).map(([key, question]) => [key, noul(question)]))
            : {}),
          difficulty: score(DIFFICULTY_QUESTION, DIFFICULTY_RUBRIC),
        },
      );
      const readiness = checkReadiness ? readinessOf(answers) : undefined;
      const tier = tierOf(answers?.difficulty, kind, config.minConfidence);
      return { ...(readiness ? { readiness } : {}), ...(tier ? { tier } : {}) };
    },

    async egress({ task, method, url }) {
      let key: string;
      try {
        const parsed = new URL(url);
        // Per path, not per host: one judged URL must not vouch for the rest of the host.
        key = `${method} ${parsed.host}${parsed.pathname}`;
      } catch {
        return "deny";
      }
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

    async verdict({ task, reported, summary, diffStat, commits, changedFiles, lastTest }) {
      const labels = ["done", "partial", "blocked", "needs_human"] as const;
      const criteria = acceptanceCriteria(task);
      const questions: Record<string, unknown> = {
        verdict: choice("Given the ticket, the worker's report and the evidence (commits, changed files, last test run), what is the real state of the work?", {
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
      const answers = await run(
        {
          ticket: clip(task, 6_000),
          workerSaid: reported,
          summary: clip(summary, 6_000),
          commits: clip(commits, 3_000),
          changedFiles: clip(changedFiles.join("\n"), 3_000),
          diffStat: clip(diffStat, 3_000),
          // A signal, not proof: the guest controls the repository and what its tests do.
          lastTestRun: lastTest
            ? { command: clip(lastTest.command, 500), exitCode: lastTest.exitCode, note: "run in the worker's sandbox; -1 means it did not complete; a pipeline's exit code is its last stage's" }
            : "none recorded",
        },
        questions,
      );
      const verdict = choiceOf(answers?.verdict, labels, config.minConfidence);
      const unmet = criteria.some((_, index) => {
        const probability = noulOf(answers?.[`criterion${index + 1}`]);
        return probability !== undefined && band(probability) === "no";
      });
      // An unmet criterion makes Jev's verdict at most partial; blocked and needs_human stand.
      return unmet && (verdict === undefined || verdict === "done") ? "partial" : verdict;
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

    async stuck({ task, runs }) {
      const answers = await run(
        {
          ticket: clip(task, 3_000),
          // Oldest first; recorded on the host, output is the tail of stdout and stderr.
          recentCommands: runs.map((entry) => ({
            command: clip(entry.command, 500),
            exitCode: entry.exitCode,
            ...(entry.output ? { outputTail: clip(entry.output, 1_000) } : {}),
          })),
          note: "exit code -1 means the command did not complete (timeout, abort)",
        },
        {
          stuck: noul("Is this coding agent repeating the same failed approach without changing strategy?", {
            true: "It retries the same or trivially varied commands and gets the same failure.",
            false: "Each attempt changes something meaningful, or the failures are expected steps (e.g. red tests before a fix).",
          }),
        },
      );
      const probability = noulOf(answers?.stuck);
      if (probability === undefined) return undefined;
      const answer = band(probability);
      return answer === "unsure" ? undefined : answer === "yes";
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
    return { answers: result.answers as Record<string, unknown>, inputTokens: result.usage.input_tokens };
  };
}
