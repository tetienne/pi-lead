import type { ReportCard } from "./delegate.ts";
import type { WorkerVerdict } from "./jev.ts";
import { cleanLines, type Paint } from "./tool-display.ts";
import { safePreview } from "./report-guard.ts";

/**
 * A worker report as a card in the Lead's transcript. The model receives the
 * report's full text either way; this is only what the user sees. The report
 * guard treats the user's next message as having seen every report, so the
 * card never shows host fields alone: the worker's own words are always
 * there, labelled untrusted, and expanding shows the full text.
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

const SUMMARY_LINES = 3;

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
    typeof card.summary === "string" &&
    Array.isArray(card.next)
  );
}

/** The card's text, or undefined for a report without a card (another version, a stop): Pi then shows the plain text. */
export function renderCard(details: unknown, content: string, expanded: boolean, paint: Paint): string | undefined {
  const report = details as ReportDetails | undefined;
  const status = report?.status as Status | undefined;
  if (!report || !status || !(status in HEADLINE) || !isCard(report.card)) return undefined;
  const card = report.card;
  const head = HEADLINE[status];
  const model = card.model.slice(card.model.indexOf("/") + 1);
  const lines = [
    `${paint(head.color, head.glyph)} ${paint("accent", safePreview(card.kind, 20))} · ${safePreview(card.title, 80)}: ` +
      `${paint(head.color, head.text)} in ${duration(card.elapsedMs)}${paint("dim", ` · ${safePreview(model, 60)} (${safePreview(card.thinking, 10)})`)}`,
  ];
  if (report.jevVerdict && report.reported && report.jevVerdict !== report.reported) {
    lines.push(paint("warning", `  ▲ the worker said ${report.reported}, Jev judged ${report.jevVerdict}`));
  }
  const work = [
    ...(card.commits ? [`${card.commits} commit${card.commits === 1 ? "" : "s"}`] : []),
    ...(card.diff ? [safePreview(card.diff, 120)] : []),
  ];
  if (work.length) lines.push(`  ${work.join(" · ")}`);
  if (card.verify) lines.push(paint(/passed/.test(card.verify) ? "success" : "warning", `  ${safePreview(card.verify, 200)}`));
  if (report.review) lines.push(`  Jev review severity ${report.review.severity.toFixed(1)}/4 → ${safePreview(report.review.action, 20)}`);
  if (card.branch) lines.push(paint("dim", `  branch ${safePreview(card.branch, 120)}`));
  if (report.sensitive?.length) {
    lines.push(paint("warning", `  ! review before merging: ${report.sensitive.map((pattern) => safePreview(pattern, 60)).join(", ")}`));
  }

  if (expanded) {
    lines.push("", paint("dim", cleanLines(content, 400)));
    return lines.join("\n");
  }
  const said = card.summary.trim().split("\n");
  lines.push(paint("muted", "  worker says (untrusted):"));
  for (const line of said.slice(0, SUMMARY_LINES)) lines.push(`    ${safePreview(line, 200)}`);
  if (said.length > SUMMARY_LINES) lines.push(paint("dim", `    … ${said.length - SUMMARY_LINES} more lines: expand to read the full report`));
  for (const step of card.next) lines.push(paint("dim", `  next: ${safePreview(step, 300)}`));
  return lines.join("\n");
}
