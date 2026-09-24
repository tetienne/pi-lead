import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Host-side Herdr presentation. Workers never receive the Herdr socket. */
export type Herdr = {
  /** The Lead's own workspace, where worker tabs open. */
  readonly workspace: string;
  /** Open a named tab without stealing focus and type `command` into its shell. */
  openWorkerTab(input: { label: string; cwd: string; command: string }): Promise<{ tabId: string; paneId: string }>;
  /** Submit text to the Pi running in a pane, as if typed (bracketed paste, then Enter). */
  sendToAgent(paneId: string, text: string): Promise<void>;
  /** Close a tab; this kills the processes in its panes (worker Pi and its VM). */
  closeTab(tabId: string): Promise<void>;
  /** Ids of the tabs that currently exist in a workspace. */
  listTabs(workspace: string): Promise<string[]>;
  /**
   * Display-only pane metadata (title, sidebar name, tokens, working label).
   * Never lifecycle state: that stays with Herdr's Pi integration.
   */
  reportMetadata(paneId: string, metadata: PaneMetadata): Promise<void>;
  /** Name the agent in a pane (live-unique); fails until Herdr has detected the agent. */
  renameAgent(paneId: string, name: string): Promise<void>;
  /** Relabel a tab (the worker's state glyph and title). */
  renameTab(tabId: string, label: string): Promise<void>;
  /** A Herdr toast, for a worker that stopped and needs the user. */
  notify(title: string, sound: "request" | "none"): Promise<void>;
};

export type PaneMetadata = {
  title: string;
  displayAgent: string;
  tokens: Record<string, string>;
  /** Shown instead of "working" while the agent works, "idle" and "done" once it stopped, "blocked" on a dialog. */
  workingLabel: string;
  idleLabel: string;
  blockedLabel: string;
  /** Orders reports: Herdr ignores one older than the last it applied. */
  seq: number;
};

/** `--agent pi` makes Herdr apply the presentation fields only while a Pi occupies the pane. */
export const METADATA_SOURCE = "custom:pi-lead";

function findString(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[field] === "string") return record[field];
  for (const nested of Object.values(record)) {
    const found = findString(nested, field);
    if (found) return found;
  }
  return undefined;
}

function collectStrings(value: unknown, field: string, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  if (typeof record[field] === "string") found.push(record[field]);
  for (const nested of Object.values(record)) collectStrings(nested, field, found);
  return found;
}

/**
 * Herdr rejected the command line itself: an older Herdr without that
 * subcommand or flag (clap exits 2). A timeout, a busy socket or a missing
 * tab is not one, and never switches a feature off.
 */
export function isUsageError(error: unknown): boolean {
  const failure = error as { code?: unknown; stderr?: unknown; message?: unknown } | undefined;
  if (failure?.code === 2) return true;
  const text = `${typeof failure?.stderr === "string" ? failure.stderr : ""}\n${typeof failure?.message === "string" ? failure.message : ""}`;
  return /unrecognized subcommand|unexpected argument|unrecognized option|invalid value/i.test(text);
}

/** The workspace is the prefix of a pane or tab id (`<workspace>:<pane>`, `<workspace>:<tab>`). */
export function workspaceFromPaneId(paneId: string | undefined): string | undefined {
  const separator = paneId?.indexOf(":") ?? -1;
  return paneId && separator > 0 ? paneId.slice(0, separator) : undefined;
}

export function createHerdrCli(environment: NodeJS.ProcessEnv = process.env): Herdr | undefined {
  const workspace = workspaceFromPaneId(environment.HERDR_PANE_ID);
  if (environment.HERDR_ENV !== "1" || !workspace) return undefined;
  const herdr = async (args: string[]) => {
    const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 });
    return stdout.trim() ? (JSON.parse(stdout) as unknown) : undefined;
  };
  /** Set once a full metadata report failed and the older form went through. */
  let legacyMetadata = false;
  return {
    workspace,
    async openWorkerTab({ label, cwd, command }) {
      const created = await herdr(["tab", "create", "--workspace", workspace, "--cwd", cwd, `--label=${label}`, "--no-focus"]);
      const tabId = findString(created, "tab_id");
      const paneId = findString(created, "pane_id");
      if (!tabId || !paneId) throw new Error("herdr did not return tab_id and pane_id");
      await herdr(["pane", "run", paneId, command]);
      return { tabId, paneId };
    },
    async sendToAgent(paneId, text) {
      // Only through the agent surface: the target must be a live, detected
      // agent (HERDR_AGENT=pi, Herdr's Pi integration). Never type into the
      // pane, which could be a host shell once Pi has exited.
      await herdr(["agent", "prompt", paneId, text]);
    },
    async closeTab(tabId) {
      await herdr(["tab", "close", tabId]);
    },
    async listTabs(inWorkspace) {
      return collectStrings(await herdr(["tab", "list", "--workspace", inWorkspace]), "tab_id");
    },
    async reportMetadata(paneId, { title, displayAgent, tokens, workingLabel, idleLabel, blockedLabel, seq }) {
      // argv, never a shell: titles and branches are user/model text; `=` keeps a value from reading as a flag.
      const base = [
        "pane",
        "report-metadata",
        "--source",
        METADATA_SOURCE,
        "--agent",
        "pi",
        `--title=${title}`,
        `--display-agent=${displayAgent}`,
        ...Object.entries(tokens).map(([name, value]) => `--token=${name}=${value}`),
        `--state-label=working=${workingLabel}`,
      ];
      const full = [
        ...base,
        `--state-label=idle=${idleLabel}`,
        `--state-label=done=${idleLabel}`,
        `--state-label=blocked=${blockedLabel}`,
        `--seq=${seq}`,
        "--",
        paneId,
      ];
      if (!legacyMetadata) {
        try {
          return void (await herdr(full));
        } catch (error) {
          // A Herdr without `--seq` or these state labels rejects the whole report: keep what it knows.
          if (!isUsageError(error)) throw error;
          try {
            await herdr([...base, "--", paneId]);
          } catch {
            throw error;
          }
          legacyMetadata = true;
          return;
        }
      }
      await herdr([...base, "--", paneId]);
    },
    async renameAgent(paneId, name) {
      await herdr(["agent", "rename", paneId, name]);
    },
    async renameTab(tabId, label) {
      await herdr(["tab", "rename", "--", tabId, label]);
    },
    async notify(title, sound) {
      await herdr(["notification", "show", `--sound=${sound}`, "--", title]);
    },
  };
}
