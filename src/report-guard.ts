import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, type LeadGuardMode } from "./config.ts";

/** The custom message type the Lead uses to deliver worker results. */
export const WORKER_REPORT_TYPE = "pi-lead-worker";

/**
 * Tools the Lead may run without asking even while a worker report is in the
 * conversation: they only read the host (`git_read` validates its arguments
 * down to read-only git), or start / talk to a worker (`worker` message
 * text goes to the worker's Pi process, not to the host). Everything else —
 * bash, powershell, write, edit, and any tool another extension registers — is
 * treated as able to execute or write on the host.
 */
export const UNGUARDED_TOOLS: ReadonlySet<string> = new Set(["read", "ls", "find", "grep", "git_read", "delegate", "worker"]);

const PREVIEW_LIMIT = 400;

type MessageLike = { role?: string; customType?: string; content?: unknown };

function reportKey(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? null);
}

/** One line of printable text: no terminal escapes or control characters from a model-written argument. */
export function safePreview(value: unknown, limit = PREVIEW_LIMIT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "";
  const clean = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "\u00b7")
    .replace(/\n/g, "⏎ ");
  return clean.length > limit ? `${clean.slice(0, limit)}… (${clean.length - limit} more chars)` : clean;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
    case "powershell":
      return `${toolName}: ${safePreview(input.command)}`;
    case "write":
      return `write ${safePreview(input.path, 200)} (${typeof input.content === "string" ? input.content.length : 0} chars)`;
    case "edit":
      return `edit ${safePreview(input.path, 200)}`;
    default:
      return `${safePreview(toolName, 80)} ${safePreview(input)}`;
  }
}

export type ReportGuardOptions = {
  /** Reads `leadGuard` for the session; defaults to the PI Lead config (global file only for `off`). */
  loadMode?: (ctx: ExtensionContext) => Promise<LeadGuardMode>;
  /** How long the confirmation waits before it counts as a refusal. */
  confirmTimeoutMs?: number;
};

export type ReportGuard = {
  /** True while a worker report the human has not answered is in the conversation. */
  readonly tainted: boolean;
};

/**
 * Deterministic host-side guard against a prompt-injected worker steering the
 * Lead. Worker reports are text written by a worker model that read
 * untrusted code; the Lead's own tools run on the host too, with no isolation.
 * So from the moment a report enters the conversation until the human sends a message of
 * their own, every Lead tool call that can execute or write on the host needs
 * an explicit confirmation (and is blocked when there is no UI to ask).
 *
 * Reports are detected from the conversation itself (`message_end` for the
 * delivered custom message, and `context` before every model call, which also
 * covers resumed sessions and queued follow-ups), keyed by content so a report
 * the human has already answered does not taint again on later turns. Only
 * input typed by the human (source `interactive`) clears the taint, and only
 * for reports already delivered: a report still queued behind the human's
 * message taints when it arrives. The turn a report triggers stays guarded to
 * its end, however many tool calls the model makes. User `!` commands are the
 * human's own and never pass through `tool_call`.
 */
export function registerReportGuard(pi: ExtensionAPI, options: ReportGuardOptions = {}): ReportGuard {
  let mode: LeadGuardMode = "confirm";
  let tainted = false;
  let pendingHumanMessages = 0;
  const known = new Set<string>();

  const loadMode =
    options.loadMode ??
    (async (ctx: ExtensionContext) =>
      (await loadConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir: getAgentDir() })).leadGuard);

  const observe = (message: MessageLike | undefined) => {
    if (message?.role !== "custom" || message.customType !== WORKER_REPORT_TYPE) return;
    const key = reportKey(message.content);
    if (known.has(key)) return;
    known.add(key);
    tainted = true;
  };

  const guard: ReportGuard = {
    get tainted() {
      return mode !== "off" && tainted;
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    tainted = false;
    pendingHumanMessages = 0;
    known.clear();
    try {
      mode = await loadMode(ctx);
    } catch {
      mode = "confirm";
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as MessageLike;
    if (message.role === "user" && pendingHumanMessages > 0) {
      pendingHumanMessages--;
      humanSpoke(ctx);
    }
    observe(message);
  });

  pi.on("context", (event) => {
    for (const message of event.messages) observe(message as MessageLike);
  });

  // The human is back in the loop and has seen every report delivered so far,
  // including those in a resumed session's transcript.
  const humanSpoke = (ctx: ExtensionContext) => {
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom_message" && entry.customType === WORKER_REPORT_TYPE) known.add(reportKey(entry.content));
      }
    } catch {
      // Without the transcript, reports of a resumed session taint once more; that only asks more.
    }
    tainted = false;
  };

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    // Typed while a turn runs (steer or follow-up): the model keeps acting on
    // the report until the message actually reaches it, so clear only then.
    if (event.streamingBehavior) pendingHumanMessages++;
    else humanSpoke(ctx);
    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!guard.tainted || UNGUARDED_TOOLS.has(event.toolName)) return undefined;
    const call = describeToolCall(event.toolName, event.input as Record<string, unknown>);
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `PI Lead guard: a worker report is in the conversation, and ${event.toolName} runs on the host. Without a UI to confirm it, it is blocked; tell the user what you wanted to run.`,
      };
    }
    const allowed = await ctx.ui.confirm(
      "PI Lead guard",
      `A worker report (untrusted text) is in the conversation. The Lead wants to run on your machine:\n\n${call}\n\nAllow?`,
      { timeout: options.confirmTimeoutMs ?? 300_000 },
    );
    return allowed
      ? undefined
      : {
          block: true,
          reason: `PI Lead guard: the user declined ${event.toolName} while a worker report is in the conversation. Do not retry it; ask the user.`,
        };
  });

  return guard;
}
