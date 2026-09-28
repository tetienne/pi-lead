import type { JevDecision } from "./jev.ts";

/**
 * How Jev's work shows in the terminal. Pure formatting, so the Lead only
 * wires these strings to Pi's UI:
 *
 * - `◆` Jev decided and its answer applied;
 * - `◇` Jev was unsure or failing, and a default applied;
 * - `▲` Jev overrode the worker (a more pessimistic verdict).
 */

/** Custom entry type of the Lead's transcript lines; never sent to the model. */
export const JEV_ENTRY = "pi-lead-jev";

function glyph(decision: Pick<JevDecision, "applied">): string {
  return decision.applied === "fallback" ? "◇" : decision.applied === "overridden" ? "▲" : "◆";
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
    (["confidence", "probability"] as const).every((key) => decision[key] === undefined || typeof decision[key] === "number") &&
    (decision.detail === undefined || typeof decision.detail === "string")
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

/**
 * Printable ASCII and the few symbols these lines use: all one terminal column
 * wide. A stored entry is replayed from the session file, so anything else
 * (escape sequences, wide or zero-width characters) is replaced rather than
 * trusted to fit, since Pi aborts on a line wider than the terminal.
 */
const safe = (line: string) => line.replace(/[^\x20-\x7e◆◇▲→…·]/gu, "?");

function fit(line: string, width: number): string {
  const chars = [...safe(line)];
  return chars.length <= width ? chars.join("") : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** The transcript entry's line, at most `width` columns, before theming. */
export const renderDecision = (decision: JevDecision, width: number) => fit(decisionLine(decision), width);
