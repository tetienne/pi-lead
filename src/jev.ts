import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { choice, noul, score, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

import type { LeadConfig, Tier } from "./config.ts";
import type { Verification } from "./protocol.ts";

/**
 * Jev answers closed-set questions; this module maps each answer to a
 * deterministic action. Every judgment returns `undefined` when Jev is not
 * configured, over budget, failing or unsure, and callers then fall back to a
 * documented default or ask the human.
 */

export type WorkKind = "implement" | "prototype" | "debug" | "review" | "research" | "scout";
export type WorkerVerdict = "done" | "partial" | "blocked" | "needs_human";
export type FailureKind = "transient" | "environment" | "task_bug" | "needs_info";
export type ReviewAction = "none" | "auto_fix" | "escalate";
export type EgressDecision = "allow" | "deny" | "ask";
export type TierJudgment = { tier: Tier; difficulty: number };
export type ReadinessJudgment = { ready: boolean; missing: string[] };

/** What a Jev call was about; `tier` covers both `modelTier` and `intake`. */
export const JEV_KINDS = ["tier", "overlap", "verdict", "review", "failure", "egress"] as const;
export type JevKind = (typeof JEV_KINDS)[number];

/**
 * One judgment, for display only. `jev`: Jev's answer was applied; `fallback`:
 * Jev was unsure, failing or over budget and a default applied; `overridden`:
 * Jev's answer replaced the worker's (a more pessimistic verdict). Every text
 * field is built here from closed labels, except `detail` on egress, which
 * carries the request's method and a clipped host + path.
 */
export type JevDecision = {
  kind: JevKind;
  outcome: string;
  applied: "jev" | "fallback" | "overridden";
  /** Of a choice or score answer. */
  confidence?: number;
  /** Of a yes/no answer. */
  probability?: number;
  detail?: string;
  at: number;
};

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
    /**
     * The project's `verify` command, run by host-side code after the last
     * commit; the worker controls the repository, so its output is worker text.
     */
    verification?: Pick<Verification, "command" | "exitCode" | "outputTail">;
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

const clip = (text: string, max = 12_000) => (text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text);

/** Difficulty rubric: 0 trivial … 4 hard. */
export const DIFFICULTY_RUBRIC = [
  "Trivial: a one-line or mechanical change, rename, copy edit or config tweak.",
  "Easy: a small, local change in one module with an obvious approach.",
  "Moderate: a feature slice touching a few modules with tests to write.",
  "Hard: cross-cutting change, subtle logic, concurrency, security or performance work.",
  "Very hard: architectural change, ambiguous requirements, or deep debugging.",
] as const;

/** The tier used when Jev gives no difficulty. */
export function defaultTier(kind: WorkKind): Tier {
  return kind === "debug" || kind === "review" ? "deep" : "standard";
}

/** Least to most pessimistic; the Lead trusts the more pessimistic of the worker and Jev. */
export const VERDICT_ORDER: readonly WorkerVerdict[] = ["done", "partial", "blocked", "needs_human"];

export function tierForDifficulty(difficulty: number, kind: WorkKind): Tier {
  // Review and debugging read more than they write; never send them to the
  // fast tier. A scout must read as carefully, so it gets the same floor.
  const floor: Tier = kind === "debug" || kind === "review" || kind === "scout" ? "standard" : "fast";
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

export type KindUsage = { calls: number; usd: number };
/** One day of Jev use, across the Lead and every worker. */
export type JevUsage = { day: string; usd: number; calls: number; kinds: Partial<Record<JevKind, KindUsage>> };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** Tolerant of the older `{ day, usd }` file and of anything malformed. */
export function parseUsage(raw: unknown, day: string): JevUsage {
  const ledger = (raw ?? {}) as { day?: unknown; usd?: unknown; calls?: unknown; kinds?: unknown };
  if (ledger.day !== day || !Number.isFinite(ledger.usd)) return { day, usd: 0, calls: 0, kinds: {} };
  const kinds: JevUsage["kinds"] = {};
  const stored = typeof ledger.kinds === "object" && ledger.kinds !== null ? (ledger.kinds as Record<string, unknown>) : {};
  for (const kind of JEV_KINDS) {
    const entry = stored[kind] as { calls?: unknown; usd?: unknown } | undefined;
    if (entry && typeof entry === "object") kinds[kind] = { calls: count(entry.calls), usd: count(entry.usd) };
  }
  return { day, usd: ledger.usd as number, calls: count(ledger.calls), kinds };
}

/** File-backed so the Lead and every worker share one daily budget. */
export function createLedger(path = join(homedir(), ".pi", "agent", "pi-lead", "jev-usage.json")) {
  const today = () => new Date().toISOString().slice(0, 10);
  const read = async (): Promise<JevUsage> => {
    try {
      return parseUsage(JSON.parse(await readFile(path, "utf8")), today());
    } catch {
      return { day: today(), usd: 0, calls: 0, kinds: {} };
    }
  };
  const write = async (usd: number, kind?: JevKind) => {
    const ledger = await read();
    ledger.usd += usd;
    if (kind) {
      ledger.calls += 1;
      const entry = ledger.kinds[kind] ?? { calls: 0, usd: 0 };
      ledger.kinds[kind] = { calls: entry.calls + 1, usd: entry.usd + usd };
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(ledger));
    await rename(temporary, path);
  };
  let queue: Promise<void> = Promise.resolve();
  return {
    spent: async () => (await read()).usd,
    usage: read,
    charge(usd: number, kind?: JevKind): Promise<void> {
      // Parallel judgments (a worker's egress, most often) charge one at a time
      // within a process, so they neither lose each other's update nor share a
      // temporary file; other processes can still race, as before.
      const next = queue.then(() => write(usd, kind));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export type Ledgerish = Pick<ReturnType<typeof createLedger>, "spent" | "charge">;

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

/** Method and host + path of a worker's request, safe to show: no query, no control characters, at most `max` characters. */
export function describeRequest(method: string, url: string, max = 80): string {
  let target: string;
  try {
    const parsed = new URL(url);
    target = `${parsed.host}${parsed.pathname}`.replace(/[^\x21-\x7e]/g, "");
  } catch {
    target = "(invalid URL)";
  }
  const verb = method.replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase() || "?";
  return `${verb} ${target.length > max ? `${target.slice(0, max - 1)}…` : target}`;
}

type Call = { answers?: Record<string, unknown>; failure?: JevProblem["kind"] };
type DecisionInput = Omit<JevDecision, "at">;

const FALLBACK_REASON: Record<JevProblem["kind"] | "unsure", string> = { unsure: "unsure", budget: "over budget", error: "failing" };

export function createJudge(options: {
  ask?: AskJev;
  config: LeadConfig["jev"];
  ledger: Ledgerish;
  /** Called at most once per kind per judge: the first failure, the first time the budget is spent. */
  onProblem?: (problem: JevProblem) => void;
  /** Called once per judgment Jev was asked for (not for cached answers, nor when Jev is not configured). */
  onDecision?: (decision: JevDecision) => void;
}): Judge {
  const { ask, config, ledger, onProblem, onDecision } = options;
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

  /** For a fallback, `outcome` names the default that applies; the reason is prefixed here. */
  const emit = (call: Call | undefined, decision: DecisionInput) => {
    if (!call || !onDecision) return;
    const outcome = decision.applied === "fallback" ? `${FALLBACK_REASON[call.failure ?? "unsure"]} → ${decision.outcome}` : decision.outcome;
    try {
      onDecision({ ...decision, outcome, at: Date.now() });
    } catch {
      // Display only: never let it change a decision.
    }
  };

  const run = async (kind: JevKind, state: unknown, questions: Record<string, unknown>): Promise<Call | undefined> => {
    if (!ask) return undefined;
    try {
      if ((await ledger.spent()) >= config.dailyBudgetUsd) {
        report("budget", `Jev's daily budget ($${config.dailyBudgetUsd}) is spent`);
        return { failure: "budget" };
      }
      const result = await ask(state, questions, AbortSignal.timeout(15_000));
      await ledger.charge((result.inputTokens / 1_000_000) * config.inputUsdPerMillion, kind);
      return { answers: result.answers };
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "unknown error";
      report("error", text.length > 200 ? `${text.slice(0, 200)}…` : text);
      return { failure: "error" };
    }
  };

  const confidence = (answer: unknown) => {
    const value = (answer as { confidence?: unknown } | undefined)?.confidence;
    return isProbability(value) ? { confidence: value } : {};
  };

  const tierDecision = (answer: unknown, kind: WorkKind, judged: TierJudgment | undefined, extra?: string): DecisionInput => {
    const detail = [extra, judged ? `difficulty ${judged.difficulty.toFixed(1)}/4` : undefined].filter(Boolean).join(", ");
    return {
      kind: "tier",
      outcome: judged ? judged.tier : defaultTier(kind),
      applied: judged ? "jev" : "fallback",
      ...confidence(answer),
      ...(detail ? { detail } : {}),
    };
  };

  return {
    available: ask !== undefined,

    async modelTier({ task, kind }) {
      const call = await run("tier", { kind, task: clip(task) }, { difficulty: score(DIFFICULTY_QUESTION, DIFFICULTY_RUBRIC) });
      const judged = tierOf(call?.answers?.difficulty, kind, config.minConfidence);
      emit(call, tierDecision(call?.answers?.difficulty, kind, judged));
      return judged;
    },

    async intake({ task, kind, checkReadiness }) {
      const call = await run(
        "tier",
        { kind, ticket: clip(task) },
        {
          ...(checkReadiness
            ? Object.fromEntries(Object.entries(READINESS_CHECKS).map(([key, question]) => [key, noul(question)]))
            : {}),
          difficulty: score(DIFFICULTY_QUESTION, DIFFICULTY_RUBRIC),
        },
      );
      const answers = call?.answers;
      const readiness = checkReadiness ? readinessOf(answers) : undefined;
      const tier = tierOf(answers?.difficulty, kind, config.minConfidence);
      if (readiness && !readiness.ready) {
        emit(call, { kind: "tier", outcome: "not ready", applied: "jev", detail: `missing ${readiness.missing.join(", ")}` });
      } else {
        emit(call, tierDecision(answers?.difficulty, kind, tier, !checkReadiness ? undefined : readiness ? "ready" : "readiness unsure"));
      }
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
      const call = await run(
        "egress",
        { ticket: clip(task, 4_000), request: { method, url: clip(url, 500) } },
        {
          needed: noul(
            "Is this network request plausibly needed to do the ticket (installing declared dependencies, fetching docs or sources it names)?",
            { true: "Needed for the ticket.", false: "Unrelated, exfiltration-like, or sending data somewhere the ticket does not need." },
          ),
        },
      );
      const probability = noulOf(call?.answers?.needed);
      const decision: EgressDecision =
        probability === undefined ? "ask" : { yes: "allow", no: "deny", unsure: "ask" }[band(probability, 0.15, 0.85)] as EgressDecision;
      if (decision !== "ask") egressCache.set(key, decision);
      emit(call, {
        kind: "egress",
        outcome: decision === "ask" ? "asks you" : decision,
        applied: decision === "ask" ? "fallback" : "jev",
        ...(probability !== undefined ? { probability } : {}),
        detail: describeRequest(method, url),
      });
      return decision;
    },

    async verdict({ task, reported, summary, diffStat, commits, changedFiles, verification }) {
      const labels = ["done", "partial", "blocked", "needs_human"] as const;
      const criteria = acceptanceCriteria(task);
      const questions: Record<string, unknown> = {
        verdict: choice("Given the ticket, the worker's report and the evidence (commits, changed files, verification run), what is the real state of the work?", {
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
        "verdict",
        {
          ticket: clip(task, 6_000),
          workerSaid: reported,
          summary: clip(summary, 6_000),
          commits: clip(commits, 3_000),
          changedFiles: clip(changedFiles.join("\n"), 3_000),
          diffStat: clip(diffStat, 3_000),
          // The command and exit code are the host's; the output was produced by the worker.
          verification: verification
            ? {
                command: clip(verification.command, 500),
                exitCode: verification.exitCode,
                outputTail: clip(verification.outputTail, 2_000),
                note: "the project's verify command, run by PI Lead in the worker's worktree after its last commit; -1 means it did not complete",
              }
            : "none: no run of the project's verify command for this result",
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

    async reviewSeverity(findings) {
      const call = await run(
        "review",
        { findings: clip(findings) },
        { severity: score("How severe are the most serious findings in this code review?", SEVERITY_RUBRIC) },
      );
      const severity = scoreOf(call?.answers?.severity, SEVERITY_RUBRIC.length, config.minConfidence);
      const common = { kind: "review" as const, ...confidence(call?.answers?.severity) };
      if (severity === undefined) {
        emit(call, { ...common, outcome: "no severity", applied: "fallback" });
        return undefined;
      }
      const action = actionForSeverity(severity);
      emit(call, { ...common, outcome: action, applied: "jev", detail: `severity ${severity.toFixed(1)}/4` });
      return { severity, action };
    },

    async failureKind({ task, log }) {
      const labels = ["transient", "environment", "task_bug", "needs_info"] as const;
      const call = await run(
        "failure",
        { ticket: clip(task, 4_000), failure: clip(log, 8_000) },
        {
          kind: choice("Why did this coding worker fail?", {
            transient: "A flaky network, rate limit, timeout or crash unrelated to the task; retrying may work.",
            environment: "Missing tool, dependency or permission in the worker's environment.",
            task_bug: "The code or tests are genuinely wrong and need diagnosis.",
            needs_info: "The ticket is unclear or a human decision is missing.",
          }),
        },
      );
      const kind = choiceOf(call?.answers?.kind, labels, config.minConfidence);
      emit(call, {
        kind: "failure",
        outcome: kind ?? "not transient",
        applied: kind ? "jev" : "fallback",
        ...confidence(call?.answers?.kind),
      });
      return kind;
    },

    async overlap(a, b) {
      const call = await run(
        "overlap",
        { first: clip(a, 5_000), second: clip(b, 5_000) },
        { overlap: noul("Would doing these two tickets in parallel likely edit the same files or the same behaviour?") },
      );
      const probability = noulOf(call?.answers?.overlap);
      const overlaps = probability === undefined ? undefined : probability >= 0.5;
      emit(call, {
        kind: "overlap",
        outcome: overlaps === undefined ? "waits" : overlaps ? "overlaps → waits" : "independent → parallel",
        applied: overlaps === undefined ? "fallback" : "jev",
        ...(probability !== undefined ? { probability } : {}),
      });
      return overlaps;
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
