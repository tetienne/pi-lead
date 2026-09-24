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

/** Every line the worker wrote, each behind a painted gutter, so none can pass for a host line. */
function workerLines(text: string, paint: Paint): string[] {
  const gutter = paint("muted", "  │ ");
  return [paint("muted", "  worker says (untrusted):"), ...cleanLines(text, Number.POSITIVE_INFINITY, 2_000).split("\n").map((line) => `${gutter}${line.trimStart()}`)];
}

/**
 * The card's text, or undefined for a report without a card (another
 * version, a stop): Pi then shows the plain text. Collapsed, it shows host
 * facts and every untrusted line (summary, commits, diff stat, findings,
 * verify output); expanded, the full report exactly as the model reads it.
 */
export function renderCard(details: unknown, content: string, expanded: boolean, paint: Paint): string | undefined {
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

  if (expanded) {
    lines.push("", paint("dim", cleanLines(content, Number.POSITIVE_INFINITY, 2_000)));
    return lines.join("\n");
  }
  const said = untrustedBlock(content) ?? card.summary;
  if (said?.trim()) lines.push(...workerLines(said, paint));
  for (const step of card.next) lines.push(paint("dim", `  next: ${safePreview(step, 300)}`));
  return lines.join("\n");
}
