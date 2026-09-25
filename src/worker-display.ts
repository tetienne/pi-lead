import type { WorkKind, WorkerVerdict } from "./jev.ts";

/**
 * How workers show outside the conversation: Herdr tab labels and state
 * labels, notifications, the Lead's footer and progress lines. Pure
 * formatting, like jev-display.ts. Every glyph is one column wide, and each
 * is a distinct shape, so none relies on colour:
 *
 * - `○` queued or starting, `●` running;
 * - `?` waiting for the user's answer, `~` partial, `✗` blocked or failed;
 * - `✓` done, `-` stopped.
 *
 * Titles come from the Lead model, which may have read a worker report, so
 * whatever reaches Herdr passes an allowlist; everything else here is a
 * fixed host string.
 */

/** The lifecycle states of delegate.ts, repeated so this module stays free of it. */
export type WorkerDisplayState = "queued" | "starting" | "running" | "waiting" | "done" | "failed" | "stopped";

export type WorkerView = {
  kind: WorkKind;
  title: string;
  state: WorkerDisplayState;
  /** Why a waiting worker waits: the verdict of its last finish. */
  verdict?: WorkerVerdict;
};

export function stateGlyph({ state, verdict }: Pick<WorkerView, "state" | "verdict">): string {
  switch (state) {
    case "queued":
    case "starting":
      return "○";
    case "running":
      return "●";
    case "waiting":
      return verdict === "partial" ? "~" : verdict === "blocked" ? "✗" : "?";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "stopped":
      return "-";
  }
}

const TITLE_COLUMNS = 32;

/**
 * Letters (ASCII and Latin, all one column), digits, space and `-_.,:/()'`.
 * No escapes, control, zero-width, bidi or wide characters; clipped to 32.
 */
export function plainTitle(title: string, columns = TITLE_COLUMNS): string {
  const clean = title
    .normalize("NFC")
    .replace(/[^A-Za-z0-9À-ÖØ-öø-ɏ _.,:/()'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Never read as a command-line flag.
    .replace(/^-+\s*/, "");
  const chars = [...clean];
  const clipped = chars.length <= columns ? clean : `${chars.slice(0, columns - 1).join("").trimEnd()}…`;
  return clipped || "worker";
}

/** `● Add CSV export`: the Herdr tab label, renamed on every state change. */
export const tabLabel = (worker: WorkerView) => `${stateGlyph(worker)} ${plainTitle(worker.title)}`;

/** What a worker in this state needs from the user, as a fixed phrase. */
function waitingPhrase(verdict: WorkerVerdict | undefined): string {
  return verdict === "partial" ? "partly done, needs you" : verdict === "blocked" ? "blocked, needs you" : "needs your answer";
}

/**
 * Herdr's state labels for the pane (shown by the sidebar's `state_text`):
 * `working` while the worker's Pi runs; `idle` (also used for `done`) once it
 * stopped; `blocked` while its Pi waits on a dialog in its tab. Host strings
 * only: kind, model and thinking come from the config.
 */
export function stateLabels(worker: WorkerView, route: { model: string; thinking: string }): Record<"working" | "idle" | "blocked", string> {
  const model = route.model.slice(route.model.indexOf("/") + 1);
  const idle =
    worker.state === "waiting"
      ? waitingPhrase(worker.verdict)
      : worker.state === "done"
        ? "done"
        : worker.state === "failed"
          ? "failed"
          : worker.state === "stopped"
            ? "stopped"
            : "idle"; // live, but its Pi stopped without a finish: nothing more to say than Herdr's own
  return {
    working: `${worker.kind} · ${model} · ${route.thinking}`,
    idle,
    blocked: worker.state === "waiting" ? idle : "asks you in its tab",
  };
}

/**
 * The toast for a worker that stopped and needs the user, or undefined when
 * nothing is worth interrupting for (a clean `done` shows in the Lead). No
 * worker-written text: the question itself is read in the Lead.
 */
export function attentionNotice(worker: WorkerView): { title: string; sound: "request" | "none" } | undefined {
  const title = plainTitle(worker.title);
  if (worker.state === "waiting") {
    return { title: `${stateGlyph(worker)} ${title}: ${waitingPhrase(worker.verdict)}`, sound: worker.verdict === "needs_human" ? "request" : "none" };
  }
  // Not kept (keepFailedWorkers off): the tab is gone, but the finish may still be a question.
  if (worker.state === "failed") return { title: `✗ ${title}: ${worker.verdict && worker.verdict !== "done" ? waitingPhrase(worker.verdict) : "failed"}`, sound: worker.verdict === "needs_human" ? "request" : "none" };
  return undefined;
}

/** The Lead's footer counters: `2 running · 1 queued · 1 needs you`, or undefined with no live worker. */
export function workerCounts(workers: readonly Pick<WorkerView, "state">[]): { text: string; needsYou: boolean } | undefined {
  const count = (...states: WorkerDisplayState[]) => workers.filter((worker) => states.includes(worker.state)).length;
  const running = count("starting", "running");
  const queued = count("queued");
  const waiting = count("waiting");
  const parts = [
    ...(running ? [`${running} running`] : []),
    ...(queued ? [`${queued} queued`] : []),
    ...(waiting ? [`${waiting} needs you`] : []),
  ];
  return parts.length ? { text: `● ${parts.join(" · ")}`, needsYou: waiting > 0 } : undefined;
}

/** Custom entry type of the Lead's progress lines; never sent to the model. */
export const PROGRESS_ENTRY = "pi-lead-progress";

/**
 * One progress line (`→ "Add CSV export" started on …`) fitted to `width` columns. Its text quotes titles and
 * model ids, and a stored entry is replayed from the session file, so any
 * character outside ASCII, Latin letters and the glyphs above is replaced,
 * since Pi aborts on a line wider than the terminal.
 */
export function renderProgress(text: unknown, width: number): string {
  if (width <= 0) return "";
  const line = `→ ${typeof text === "string" ? text.normalize("NFC") : ""}`.replace(/[^\x20-\x7eÀ-ÖØ-öø-ɏ○●✓✗→…·]/gu, "?");
  const chars = [...line];
  return chars.length <= width ? line : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}
