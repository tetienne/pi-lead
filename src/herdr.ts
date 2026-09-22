import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Host-side Herdr presentation. Workers never receive the Herdr socket. */
export type Herdr = {
  /** Open a named tab without stealing focus and type `command` into its shell. */
  openWorkerTab(input: { label: string; cwd: string; command: string }): Promise<{ tabId: string; paneId: string }>;
  /** Submit text to the Pi running in a pane, as if typed (bracketed paste, then Enter). */
  sendToAgent(paneId: string, text: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
};

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

/** The workspace is the prefix of the Lead's own pane id (`<workspace>:<pane>`). */
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
  return {
    async openWorkerTab({ label, cwd, command }) {
      const created = await herdr(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label, "--no-focus"]);
      const tabId = findString(created, "tab_id");
      const paneId = findString(created, "pane_id");
      if (!tabId || !paneId) throw new Error("herdr did not return tab_id and pane_id");
      await herdr(["pane", "run", paneId, command]);
      return { tabId, paneId };
    },
    async sendToAgent(paneId, text) {
      try {
        // Targets accept the pane id hosting a detected agent (HERDR_AGENT=pi, Herdr's Pi integration).
        await herdr(["agent", "prompt", paneId, text]);
      } catch {
        // Not detected as an agent: type the text into Pi's editor as one line, then Enter.
        await herdr(["pane", "run", paneId, text.replace(/\s*\n\s*/g, " ")]);
      }
    },
    async closeTab(tabId) {
      await herdr(["tab", "close", tabId]);
    },
  };
}
