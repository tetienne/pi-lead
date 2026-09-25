import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
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
   * PR exists but runs no checks; `error` is set only when `gh` could not be
   * read at all.
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

export const gitWorkspace: Workspace = {
  repoRoot: (cwd) => git(["rev-parse", "--show-toplevel"], cwd),

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
    let url: string | undefined;
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "url"], { cwd: repoRoot, encoding: "utf8", env });
      url = (JSON.parse(stdout) as { url?: string }).url;
    } catch {
      return { state: "none", failed: [] }; // no open PR for this branch
    }
    if (!url) return { state: "none", failed: [] };
    // `gh pr checks` exits non-zero when a check fails or is pending, but still prints its JSON on stdout.
    const stdout = await execFileAsync("gh", ["pr", "checks", branch, "--json", "name,bucket,link"], { cwd: repoRoot, encoding: "utf8", env }).then(
      (result) => result.stdout,
      (error: unknown) => (error as { stdout?: string }).stdout,
    );
    if (!stdout) return { url, state: "none", failed: [] }; // "no checks reported": the repo runs none for this branch
    let checks: CheckBucket[];
    try {
      checks = JSON.parse(stdout) as CheckBucket[];
    } catch (error) {
      return { url, state: "error", failed: [], error: shortError(error) };
    }
    if (checks.length === 0) return { url, state: "none", failed: [] };
    const classified = classifyChecks(checks);
    return { url, state: classified.state, failed: classified.failed };
  },

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
