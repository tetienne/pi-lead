import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One check as `gh pr checks --json name,bucket,link` reports it. */
export type CheckBucket = { name: string; bucket: string; link: string };

/**
 * Classify a PR's checks: `fail` and `cancel` buckets both count as failed
 * (checked first, since a fail-fast watch can still leave others pending);
 * otherwise any `pending` bucket means the run isn't settled yet; `pass` only
 * once every bucket is `pass` or `skipping`.
 */
export function classifyChecks(checks: CheckBucket[]): { state: "pass" | "pending" | "fail"; failed: { name: string; link: string }[] } {
  const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map(({ name, link }) => ({ name, link }));
  if (failed.length) return { state: "fail", failed };
  if (checks.some((check) => check.bucket === "pending")) return { state: "pending", failed: [] };
  const settled = checks.filter((check) => check.bucket !== "pass" && check.bucket !== "skipping");
  return settled.length ? { state: "fail", failed: settled.map(({ name, link }) => ({ name, link })) } : { state: "pass", failed: [] };
}

/**
 * Each worker runs in a linked git worktree of the repository, created by
 * Herdr. Its branch and commits are part of the repository's own refs from
 * the moment the worktree is created: no clone, no fetch.
 */
export type Workspace = {
  repoRoot(cwd: string): Promise<string>;
  /** The main checkout, even when `repoRoot` is a linked worktree. */
  mainCheckout(repoRoot: string): Promise<string>;
  /** `startFrom` is a local branch name; defaults to the checkout's HEAD. Returns the resolved commit. */
  resolveBase(input: { repoRoot: string; startFrom?: string }): Promise<string>;
  /** The checkout's current branch, or undefined on a detached HEAD. */
  currentBranch(repoRoot: string): Promise<string | undefined>;
  collect(input: { repoRoot: string; branch: string; base: string }): Promise<{
    commits: string;
    diffStat: string;
    /** Every path the branch adds, changes, deletes or renames since `base`. */
    changedFiles: string[];
    head: string;
  }>;
  /** A file's content at `rev`, or undefined when it is absent or unreadable. */
  fileAt(input: { repoRoot: string; rev: string; path: string }): Promise<string | undefined>;
  /**
   * One non-watching read of the worker's own draft PR and its checks. Never
   * throws: `state` is `none` both when the branch has no open PR and when a
   * PR exists but runs no checks; any other `gh` failure is `error`.
   */
  prChecks(input: { repoRoot: string; branch: string }): Promise<{
    url?: string;
    state: "pass" | "fail" | "pending" | "none" | "error";
    failed: { name: string; link: string }[];
    error?: string;
  }>;
  /** Remove a task's own directory (never the repository itself). */
  remove(path: string): Promise<void>;
};

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 << 20,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

type GhRun = { stdout?: string; stderr?: string; error?: unknown };

const ghError = (run: GhRun) => run.stderr?.trim().split("\n")[0] || (run.error ? shortError(run.error) : "gh printed nothing");

/** One `gh pr checks --json` run. A gh failure is `error`, never "no checks", so it cannot leave a ticket `done`. */
export function readChecks(run: GhRun): { state: "pass" | "fail" | "pending" | "none" | "error"; failed: { name: string; link: string }[]; error?: string } {
  // `gh pr checks` exits non-zero when a check fails or is pending, but still prints its JSON on stdout.
  if (run.stdout?.trim()) {
    try {
      const checks = JSON.parse(run.stdout) as CheckBucket[];
      return checks.length === 0 ? { state: "none", failed: [] } : classifyChecks(checks);
    } catch (error) {
      return { state: "error", failed: [], error: shortError(error) };
    }
  }
  if (/no checks reported/i.test(run.stderr ?? "")) return { state: "none", failed: [] };
  return { state: "error", failed: [], error: ghError(run) };
}

export const gitWorkspace: Workspace = {
  repoRoot: (cwd) => git(["rev-parse", "--show-toplevel"], cwd),

  async mainCheckout(repoRoot) {
    return dirname(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot));
  },

  resolveBase: ({ repoRoot, startFrom }) => git(["rev-parse", startFrom ? `refs/heads/${startFrom}` : "HEAD"], repoRoot),

  async currentBranch(repoRoot) {
    try {
      return await git(["symbolic-ref", "--short", "HEAD"], repoRoot);
    } catch {
      return undefined; // detached HEAD
    }
  },

  async collect({ repoRoot, branch, base }) {
    const [commits, diffStat, names, head] = await Promise.all([
      git(["log", "--oneline", `${base}..${branch}`], repoRoot),
      git(["diff", "--stat", `${base}...${branch}`], repoRoot),
      // -z: names verbatim, unquoted; --no-renames: a rename lists its old name too.
      git(["diff", "--name-only", "-z", "--no-renames", `${base}...${branch}`], repoRoot),
      git(["rev-parse", `refs/heads/${branch}`], repoRoot),
    ]);
    return { commits, diffStat, changedFiles: names.split("\0").filter(Boolean), head };
  },

  async fileAt({ repoRoot, rev, path }) {
    // cat-file, not show: plumbing applies no textconv or other configured filter to the worker's blob.
    try {
      return await git(["cat-file", "blob", `${rev}:${path}`], repoRoot);
    } catch {
      return undefined;
    }
  },

  async prChecks({ repoRoot, branch }) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const gh = (args: string[]): Promise<GhRun> =>
      execFileAsync("gh", args, { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000 }).then(
        ({ stdout, stderr }) => ({ stdout, stderr }),
        (error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout, stderr: error.stderr, error }),
      );
    const view = await gh(["pr", "view", branch, "--json", "url"]);
    if (view.error) {
      if (/no pull requests found/i.test(view.stderr ?? "")) return { state: "none", failed: [] };
      return { state: "error", failed: [], error: ghError(view) };
    }
    let url: string | undefined;
    try {
      url = (JSON.parse(view.stdout ?? "") as { url?: string }).url;
    } catch (error) {
      return { state: "error", failed: [], error: shortError(error) };
    }
    if (!url) return { state: "none", failed: [] };
    return { url, ...readChecks(await gh(["pr", "checks", branch, "--json", "name,bucket,link"])) };
  },

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
