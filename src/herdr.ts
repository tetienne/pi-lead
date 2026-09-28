import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The Lead's Herdr client: worker worktrees, their panes and their presentation. */
export type Herdr = {
  /** The Lead's own workspace, where the Lead itself runs. */
  readonly workspace: string;
  /** Create a linked git worktree workspace for a worker; its pane starts as an idle shell. */
  createWorktree(input: { cwd: string; branch: string; base: string; path: string; label: string }): Promise<{ workspaceId: string; paneId: string }>;
  /** Type a command into an idle pane's shell, as if typed (used right after `createWorktree`). */
  runCommand(paneId: string, command: string): Promise<void>;
  /** Submit text to the Pi running in a pane, as if typed (bracketed paste, then Enter). */
  sendToAgent(paneId: string, text: string): Promise<void>;
  /** Remove a worker's worktree workspace: kills its pane and deletes the checkout. The branch is kept. */
  removeWorktree(workspaceId: string): Promise<void>;
  /** Ids of the workspaces that currently exist. */
  listWorkspaces(): Promise<string[]>;
  /**
   * Whether Herdr still detects a live agent in a pane (`herdr agent get <pane>`,
   * which only resolves a pane currently hosting one). False on any error.
   */
  hasAgent(paneId: string): Promise<boolean>;
  /**
   * Display-only pane metadata (title, sidebar name, tokens, working label).
   * Never lifecycle state: that stays with Herdr's Pi integration.
   */
  reportMetadata(paneId: string, metadata: PaneMetadata): Promise<void>;
  /** Name the agent in a pane (live-unique); fails until Herdr has detected the agent. */
  renameAgent(paneId: string, name: string): Promise<void>;
  /** Relabel a worktree workspace (the worker's state glyph and title, shown in the sidebar). */
  renameWorktree(workspaceId: string, label: string): Promise<void>;
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

/** The workspace is the prefix of a pane or tab id (`<workspace>:<pane>`, `<workspace>:<tab>`). */
export function workspaceFromPaneId(paneId: string | undefined): string | undefined {
  const separator = paneId?.indexOf(":") ?? -1;
  return paneId && separator > 0 ? paneId.slice(0, separator) : undefined;
}

export function createHerdrCli(environment: NodeJS.ProcessEnv = process.env): Herdr | undefined {
  const workspace = workspaceFromPaneId(environment.HERDR_PANE_ID);
  if (environment.HERDR_ENV !== "1" || !workspace) return undefined;
  /** Herdr answers `{ id, result }` as JSON; a failure exits non-zero, with its error on stderr. */
  const herdr = async <Result = unknown>(args: string[]): Promise<Partial<Result> | undefined> => {
    const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 });
    return stdout.trim() ? (JSON.parse(stdout) as { result?: Partial<Result> }).result : undefined;
  };
  return {
    workspace,
    async createWorktree({ cwd, branch, base, path, label }) {
      const created = await herdr<{ workspace: { workspace_id?: unknown }; root_pane: { pane_id?: unknown } }>(
        ["worktree", "create", "--cwd", cwd, "--branch", branch, "--base", base, "--path", path, "--label", label, "--no-focus"],
      );
      const workspaceId = created?.workspace?.workspace_id;
      const paneId = created?.root_pane?.pane_id;
      if (typeof workspaceId !== "string" || typeof paneId !== "string") throw new Error("herdr did not return a workspace_id and pane_id");
      return { workspaceId, paneId };
    },
    async runCommand(paneId, command) {
      await herdr(["pane", "run", paneId, command]);
    },
    async sendToAgent(paneId, text) {
      // Only through the agent surface: the target must be a live, detected
      // agent (HERDR_AGENT=pi, Herdr's Pi integration). Never type into the
      // pane, which could be a host shell once Pi has exited.
      await herdr(["agent", "prompt", paneId, text]);
    },
    async removeWorktree(workspaceId) {
      await herdr(["worktree", "remove", "--workspace", workspaceId, "--force"]);
    },
    async listWorkspaces() {
      const listed = await herdr<{ workspaces: Array<{ workspace_id: string }> }>(["workspace", "list"]);
      return (listed?.workspaces ?? []).map((workspace) => workspace.workspace_id);
    },
    async hasAgent(paneId) {
      return herdr(["agent", "get", paneId]).then(
        () => true,
        () => false,
      );
    },
    async reportMetadata(paneId, { title, displayAgent, tokens, workingLabel, idleLabel, blockedLabel, seq }) {
      // argv, never a shell: titles and branches are user/model text.
      await herdr([
        "pane",
        "report-metadata",
        paneId,
        "--source",
        METADATA_SOURCE,
        "--agent",
        "pi",
        "--title",
        title,
        "--display-agent",
        displayAgent,
        ...Object.entries(tokens).flatMap(([name, value]) => ["--token", `${name}=${value}`]),
        "--state-label",
        `working=${workingLabel}`,
        "--state-label",
        `idle=${idleLabel}`,
        "--state-label",
        `done=${idleLabel}`,
        "--state-label",
        `blocked=${blockedLabel}`,
        "--seq",
        String(seq),
      ]);
    },
    async renameAgent(paneId, name) {
      await herdr(["agent", "rename", paneId, name]);
    },
    async renameWorktree(workspaceId, label) {
      await herdr(["workspace", "rename", "--", workspaceId, label]);
    },
    async notify(title, sound) {
      await herdr(["notification", "show", title, "--sound", sound]);
    },
  };
}
