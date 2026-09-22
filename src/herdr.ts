import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Host-side Herdr presentation. Workers never receive the Herdr socket. */
export type Herdr = {
  /** Open a named tab without stealing focus and run `argv` in its pane. */
  openWorkerTab(input: { label: string; cwd: string; argv: string[] }): Promise<{ tabId: string; paneId: string }>;
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
    async openWorkerTab({ label, cwd, argv }) {
      const created = await herdr(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label, "--no-focus"]);
      const tabId = findString(created, "tab_id");
      const paneId = findString(created, "pane_id");
      if (!tabId || !paneId) throw new Error("herdr did not return tab_id and pane_id");
      await herdr(["pane", "run", paneId, ...argv]);
      return { tabId, paneId };
    },
    async closeTab(tabId) {
      await herdr(["tab", "close", tabId]);
    },
  };
}
