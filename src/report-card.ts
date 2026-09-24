import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ReportCard } from "./delegate.ts";
import type { WorkerVerdict } from "./jev.ts";
import { cleanLines, type Paint } from "./tool-display.ts";
import { safePreview } from "./report-guard.ts";

/**
 * A worker report as a card in the Lead's transcript. The model receives the
 * report's full text either way; this is only what the user sees. The report
 * guard treats the user's next message as having seen every report, so the
 * card never hides a line the worker wrote: collapsed, it shortens only the
 * host lines, and expanding shows the full text.
 */

type Status = WorkerVerdict | "failed" | "stopped";

const HEADLINE: Record<Status, { glyph: string; color: "success" | "warning" | "error" | "dim"; text: string }> = {
  done: { glyph: "✓", color: "success", text: "done" },
  partial: { glyph: "~", color: "warning", text: "partly done" },
  needs_human: { glyph: "?", color: "warning", text: "needs your answer" },
  blocked: { glyph: "✗", color: "error", text: "blocked" },
  failed: { glyph: "✗", color: "error", text: "failed" },
  stopped: { glyph: "-", color: "dim", text: "stopped" },
};

export type ReportDetails = {
  status?: unknown;
  reported?: WorkerVerdict;
  jevVerdict?: WorkerVerdict;
  review?: { severity: number; action: string };
  sensitive?: string[];
  card?: ReportCard;
};

/** `42s`, `12m`, `1h05`. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

const VERDICTS: readonly string[] = ["done", "partial", "blocked", "needs_human"];

/** The report's `<worker-report untrusted>` block, as the model reads it, or undefined. */
export function untrustedBlock(content: string): string | undefined {
  const open = content.indexOf("<worker-report untrusted>");
  const close = content.lastIndexOf("</worker-report>");
  if (open === -1 || close < open) return undefined;
  return content.slice(open + "<worker-report untrusted>".length, close).replace(/^\n+|\n+$/g, "");
}

function isCard(value: unknown): value is ReportCard {
  const card = value as Partial<ReportCard> | undefined;
  return (
    typeof card === "object" &&
    card !== null &&
    typeof card.kind === "string" &&
    typeof card.title === "string" &&
    typeof card.model === "string" &&
    typeof card.thinking === "string" &&
    typeof card.elapsedMs === "number" &&
    typeof card.commits === "number" &&
    (card.summary === undefined || typeof card.summary === "string") &&
    Array.isArray(card.next)
  );
}

/**
 * Worker text for the card: every line, uncut (the model reads all of it),
 * cleaned of escapes and controls. Tabs become spaces, since the terminal's
 * tab stops would push text past the gutter; invisible characters (zero-width,
 * BOM, Unicode tags) become `·`, so text the model can read never renders as nothing.
 */
const cleanWorkerText = (text: string) =>
  cleanLines(text.replace(/\t/g, "   ").replace(INVISIBLE, "·"), Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER);

const INVISIBLE = /[\u200b-\u200f\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/gu;

const GUTTER = "  │ ";
const NARROW_GUTTER = "│";

/**
 * The worker's lines, cleaned and wrapped to `width`, with the painted gutter on every
 * row, wrapped ones included: no row of worker text can pass for a host line.
 * No row is ever wider than `width`, which Pi would abort on.
 */
export function gutterLines(said: string, width: number, paint: Paint): string[] {
  const columns = Math.max(1, width);
  const gutter = columns >= 12 ? GUTTER : NARROW_GUTTER;
  const inner = Math.max(1, columns - visibleWidth(gutter));
  const rows = wrapTextWithAnsi("  worker says (untrusted):", columns).map((row) => paint("muted", row));
  for (const line of cleanWorkerText(said).split("\n")) {
    const wrapped = line.trim() ? wrapTextWithAnsi(line.trimStart(), inner) : [""];
    // A two-column character cannot fit a one-column row: only then is a row clipped.
    for (const row of wrapped) rows.push(`${paint("muted", gutter)}${visibleWidth(row) > inner ? truncateToWidth(row, inner, "") : row}`);
  }
  return rows.map((row) => (visibleWidth(row) > columns ? truncateToWidth(row, columns, "") : row));
}

/** The gutter block as a component, re-wrapped only when the text or the width changes. */
export function gutterBlock(said: string, paint: Paint): { render(width: number): string[]; invalidate(): void } {
  let cached: { width: number; rows: string[] } | undefined;
  return {
    render(width) {
      if (cached?.width !== width) cached = { width, rows: gutterLines(said, width, paint) };
      return cached.rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/** A card in three parts: host lines, the worker's own lines (drawn behind a gutter), host lines. */
export type CardParts = { head: string; said?: string; tail?: string };

/**
 * The card, or undefined for a report without one (another version, a
 * stop): Pi then shows the plain text. Collapsed, it shows host facts and
 * every untrusted line (summary, commits, diff stat, findings, verify
 * output); expanded, the full report exactly as the model reads it.
 */
export function renderCard(details: unknown, content: string, expanded: boolean, paint: Paint): CardParts | undefined {
  const report = details as ReportDetails | undefined;
  const status = report?.status as Status | undefined;
  if (!report || !status || !Object.hasOwn(HEADLINE, status) || !isCard(report.card)) return undefined;
  const card = report.card;
  const head = HEADLINE[status];
  const model = card.model.slice(card.model.indexOf("/") + 1);
  const lines = [
    `${paint(head.color, head.glyph)} ${paint("accent", safePreview(card.kind, 20))} · ${safePreview(card.title, 80)}: ` +
      `${paint(head.color, head.text)} in ${duration(card.elapsedMs)}${paint("dim", ` · ${safePreview(model, 60)} (${safePreview(card.thinking, 10)})`)}`,
  ];
  const { reported, jevVerdict } = report;
  if (typeof reported === "string" && typeof jevVerdict === "string" && VERDICTS.includes(reported) && VERDICTS.includes(jevVerdict) && reported !== jevVerdict) {
    lines.push(paint("warning", `  ▲ the worker said ${reported}, Jev judged ${jevVerdict}`));
  }
  const work = [
    ...(card.commits ? [`${card.commits} commit${card.commits === 1 ? "" : "s"}`] : []),
    ...(card.diff ? [safePreview(card.diff, 120)] : []),
  ];
  if (work.length) lines.push(`  ${work.join(" · ")}`);
  if (card.verify) lines.push(paint(card.verified ? "success" : "warning", `  ${safePreview(card.verify, 200)}`));
  const review = report.review;
  if (review && typeof review.severity === "number" && typeof review.action === "string") {
    lines.push(`  Jev review severity ${review.severity.toFixed(1)}/4 → ${safePreview(review.action, 20)}`);
  }
  if (card.branch) lines.push(paint("dim", `  branch ${safePreview(card.branch, 120)}`));
  if (Array.isArray(report.sensitive) && report.sensitive.length) {
    lines.push(paint("warning", `  ! review before merging: ${report.sensitive.map((pattern) => safePreview(pattern, 60)).join(", ")}`));
  }

  const block = untrustedBlock(content);
  const said = block ?? card.summary;
  const parts: CardParts = { head: lines.join("\n"), ...(said?.trim() ? { said } : {}) };
  if (expanded) {
    // The full text around the block, as the model reads it; the block itself stays behind the gutter.
    const open = content.indexOf("<worker-report untrusted>");
    const close = content.lastIndexOf("</worker-report>");
    const before = block === undefined ? content : content.slice(0, open);
    const after = block === undefined ? "" : content.slice(close + "</worker-report>".length);
    return {
      head: `${parts.head}\n\n${paint("dim", cleanWorkerText(before.replace(/\n+$/, "")))}`,
      // Without a block (a failure), the full text above already holds the error.
      ...(parts.said && block !== undefined ? { said: parts.said } : {}),
      ...(after.trim() ? { tail: paint("dim", cleanWorkerText(after.replace(/^\n+/, ""))) } : {}),
    };
  }
  return { ...parts, ...(card.next.length ? { tail: card.next.map((step) => paint("dim", `  next: ${safePreview(step, 300)}`)).join("\n") } : {}) };
}
