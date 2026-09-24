import type { StartResult, WorkerInfo } from "./delegate.ts";
import { safePreview } from "./report-guard.ts";
import { stateGlyph } from "./worker-display.ts";

/**
 * How the `delegate` and `worker` tool calls show in the Lead's transcript.
 * Pure formatting: `paint` is the theme's `fg`, and Pi's Text component
 * wraps the result to the width. Arguments are written by the Lead model and
 * results quote them, so every piece of text goes through `safePreview` (one
 * line, no escapes or control characters) or `cleanLines`.
 */

export type Color = "toolTitle" | "accent" | "muted" | "dim" | "success" | "warning" | "error";
export type Paint = (color: Color, text: string) => string;

/** Multi-line text with every line cleaned like `safePreview`, for expanded views. */
export function cleanLines(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((line) => safePreview(line, 400));
  return [...shown, ...(lines.length > maxLines ? [`… ${lines.length - maxLines} more lines`] : [])].join("\n");
}

/** `openai-codex/gpt-6-sol` → `gpt-6-sol`: the provider is noise once the tier is shown. */
const shortModel = (model: string) => model.slice(model.indexOf("/") + 1);

const routeText = (worker: WorkerInfo) =>
  `${worker.id.slice(0, 8)} · ${worker.route.tier} · ${shortModel(worker.route.model)} (${worker.route.thinking})`;
/** The quota or fallback note of a route, host-written but quoting model ids. */
const routeNote = (worker: WorkerInfo, paint: Paint) => (worker.route.note ? `\n${paint("warning", `! ${safePreview(worker.route.note, 200)}`)}` : "");

export function delegateCall(
  args: { kind?: unknown; title?: unknown; task?: unknown; startFrom?: unknown },
  paint: Paint,
): string {
  const head = [
    paint("toolTitle", "delegate "),
    paint("accent", safePreview(args.kind ?? "", 20)),
    " ",
    safePreview(args.title ?? "", 80),
    ...(typeof args.startFrom === "string" && args.startFrom ? [paint("muted", ` from ${safePreview(args.startFrom, 80)}`)] : []),
  ].join("");
  const task = typeof args.task === "string" && args.task.trim() ? `\n${paint("dim", `└ ${safePreview(args.task.trim(), 120)}`)}` : "";
  return head + task;
}

function isStartResult(value: unknown): value is StartResult {
  const status = (value as { status?: unknown } | undefined)?.status;
  return status === "started" || status === "queued" || status === "not_ready" || status === "failed";
}

/** First line of a result: what happened, with its glyph; the host text follows when expanded. */
export function delegateResult(details: unknown, text: string, expanded: boolean, paint: Paint): string {
  const more = expanded && text ? `\n${paint("dim", cleanLines(text))}` : "";
  if (!isStartResult(details)) return paint("dim", safePreview(text, 200));
  switch (details.status) {
    case "started":
      return `${paint("accent", "●")} started · ${routeText(details.worker)}${paint("dim", " · in a background Herdr tab")}${routeNote(details.worker, paint)}${more}`;
    case "queued":
      return `${paint("dim", "○")} queued · ${routeText(details.worker)}${paint("dim", " · starts when a slot or an overlapping worker frees up")}${routeNote(details.worker, paint)}${more}`;
    case "not_ready":
      return `${paint("warning", "?")} ${expanded ? cleanLines(text) : safePreview(text, 300)}`;
    case "failed":
      return `${paint("error", "✗")} ${expanded ? cleanLines(text) : safePreview(text, 300)}`;
  }
}

export function workerCall(args: { action?: unknown; id?: unknown; message?: unknown }, paint: Paint): string {
  const action = safePreview(args.action ?? "", 20);
  const target = typeof args.id === "string" && args.id ? ` ${paint("accent", safePreview(args.id, 60))}` : "";
  const message = typeof args.message === "string" && args.message.trim() ? `\n${paint("dim", `└ ${safePreview(args.message.trim(), 120)}`)}` : "";
  return `${paint("toolTitle", "worker ")}${action}${target}${action === "message" ? message : ""}`;
}

const STATE_COLOR: Record<WorkerInfo["state"], Color> = {
  queued: "dim",
  starting: "dim",
  running: "accent",
  waiting: "warning",
  done: "success",
  failed: "error",
  stopped: "dim",
};

/** One row per worker: `● Add CSV export  a1b2c3d4  implement · running · gpt-6-sol (high)`. */
export function workerRows(workers: readonly WorkerInfo[], paint: Paint): string {
  if (!workers.length) return paint("dim", "No workers.");
  return workers
    .map((worker) =>
      [
        paint(STATE_COLOR[worker.state], stateGlyph(worker)),
        " ",
        safePreview(worker.title, 60),
        paint("dim", `  ${worker.id.slice(0, 8)}  ${worker.kind} · ${worker.state} · ${shortModel(worker.route.model)} (${worker.route.thinking})`),
      ].join(""),
    )
    .join("\n");
}

/** `list` gets rows from its details; `message` and `stop` show the host's one-line answer. */
export function workerResult(details: unknown, text: string, paint: Paint): string {
  const workers = (details as { workers?: unknown } | undefined)?.workers;
  if (Array.isArray(workers)) return workerRows(workers as WorkerInfo[], paint);
  return paint("dim", safePreview(text, 200));
}
