import type { JevDisplay } from "./config.ts";
import { JEV_KINDS, type JevDecision, type JevUsage } from "./jev.ts";

/**
 * How Jev's work shows in the terminal. Pure formatting, so the Lead and the
 * worker extension only wire these strings to Pi's UI:
 *
 * - `◆` Jev decided and its answer applied;
 * - `◇` Jev was unsure, failing or over budget, and a default applied;
 * - `▲` Jev overrode the worker (a more pessimistic verdict).
 */

/** Custom entry type of the Lead's transcript lines; never sent to the model. */
export const JEV_ENTRY = "pi-lead-jev";

/** Decisions `/jev` lists. */
export const RECENT_DECISIONS = 20;

const DISPLAYS: readonly JevDisplay[] = ["quiet", "normal", "verbose"];

export function displayMode(value: unknown): JevDisplay {
  return DISPLAYS.includes(value as JevDisplay) ? (value as JevDisplay) : "normal";
}

export function glyph(decision: Pick<JevDecision, "applied">): string {
  return decision.applied === "fallback" ? "◇" : decision.applied === "overridden" ? "▲" : "◆";
}

/** Egress Jev allowed: by far the most frequent decision, and the least interesting. */
const isEgressAllow = (decision: JevDecision) => decision.kind === "egress" && decision.applied === "jev" && decision.outcome === "allow";
const isEgressDeny = (decision: JevDecision) => decision.kind === "egress" && decision.applied === "jev" && decision.outcome === "deny";

/** Whether a decision gets its own line (transcript in the Lead, notification in a worker tab). */
export function shouldShow(decision: JevDecision, display: JevDisplay): boolean {
  if (display === "verbose") return true;
  if (display === "normal") return !isEgressAllow(decision);
  // quiet: only what did not go Jev's way and egress that did not go through.
  return decision.applied !== "jev" || isEgressDeny(decision);
}

/** Is a stored entry (possibly from another version) a decision this code can render? */
export function isDecision(value: unknown): value is JevDecision {
  const decision = value as Partial<JevDecision> | undefined;
  return (
    typeof decision === "object" &&
    decision !== null &&
    typeof decision.kind === "string" &&
    typeof decision.outcome === "string" &&
    (decision.applied === "jev" || decision.applied === "fallback" || decision.applied === "overridden") &&
    typeof decision.at === "number" &&
    (["confidence", "probability", "usd", "ms"] as const).every((key) => decision[key] === undefined || typeof decision[key] === "number") &&
    (["threshold", "detail"] as const).every((key) => decision[key] === undefined || typeof decision[key] === "string")
  );
}

const fixed = (value: number, digits = 2) => value.toFixed(digits);

/** `◆ jev · tier standard (difficulty 2.1/4, conf 0.82)` */
export function decisionLine(decision: JevDecision): string {
  const notes = [
    decision.detail,
    decision.confidence !== undefined ? `conf ${fixed(decision.confidence)}` : undefined,
    decision.probability !== undefined ? `p ${fixed(decision.probability)}` : undefined,
  ].filter(Boolean);
  return `${glyph(decision)} jev · ${decision.kind} ${decision.outcome}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** The expanded view's second line: what the answer was held to and what it cost. */
export function decisionDetails(decision: JevDecision): string {
  return [
    decision.confidence !== undefined ? `confidence ${fixed(decision.confidence)}` : undefined,
    decision.probability !== undefined ? `probability ${fixed(decision.probability)}` : undefined,
    decision.threshold ? `threshold ${decision.threshold}` : undefined,
    decision.ms !== undefined ? `${Math.round(decision.ms)} ms` : undefined,
    decision.usd !== undefined ? `$${fixed(decision.usd, 6)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Printable ASCII and the few symbols these lines use: all one terminal column
 * wide. A stored entry is replayed from the session file, so anything else
 * (escape sequences, wide or zero-width characters) is replaced rather than
 * trusted to fit, since Pi aborts on a line wider than the terminal.
 */
const safe = (line: string) => line.replace(/[^\x20-\x7e◆◇▲≥≤→…·]/gu, "?");

function fit(line: string, width: number): string {
  const chars = [...safe(line)];
  return chars.length <= width ? line : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Lines of the transcript entry, each at most `width` columns, before theming. */
export function renderDecision(decision: JevDecision, expanded: boolean, width: number): string[] {
  const details = expanded ? decisionDetails(decision) : "";
  return [decisionLine(decision), ...(details ? [`  ${details}`] : [])].map((line) => fit(line, width));
}

export type StatusLevel = "dim" | "warning" | "error";

/** The Lead's status segment: `◆ 14 · $0.004/1.00`, warning from 80% of the budget, error once spent. */
export function jevStatus(usage: Pick<JevUsage, "calls" | "usd">, budgetUsd: number): { text: string; level: StatusLevel } {
  const ratio = budgetUsd > 0 ? usage.usd / budgetUsd : 1;
  return {
    text: `◆ ${usage.calls} · $${fixed(usage.usd, 3)}/${fixed(budgetUsd)}`,
    level: ratio >= 1 ? "error" : ratio >= 0.8 ? "warning" : "dim",
  };
}

const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** What `/jev` prints. */
export function jevReport(usage: JevUsage, budgetUsd: number, recent: readonly JevDecision[]): string {
  const left = Math.max(0, budgetUsd - usage.usd);
  const lines = [
    `Jev today (Lead and workers): ${usage.calls} calls · $${fixed(usage.usd, 4)} of $${fixed(budgetUsd)} · $${fixed(left, 4)} left`,
  ];
  for (const kind of JEV_KINDS) {
    const entry = usage.kinds[kind];
    if (entry?.calls) lines.push(`  ${kind.padEnd(8)} ${String(entry.calls).padStart(4)} · $${fixed(entry.usd, 4)}`);
  }
  const shown = recent.slice(-RECENT_DECISIONS);
  lines.push("", shown.length ? `Last ${shown.length} decisions this session:` : "No Jev decisions in this session yet.");
  for (const decision of shown) lines.push(`  ${clock(decision.at)} ${decisionLine(decision)}`);
  return lines.join("\n");
}
