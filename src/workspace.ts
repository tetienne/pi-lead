import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Each worker runs in a linked git worktree of the repository, created by
 * Herdr. Its branch and commits are part of the repository's own refs from
 * the moment the worktree is created: no clone, no fetch.
 */
export type Workspace = {
  repoRoot(cwd: string): Promise<string>;
  /** `startFrom` is a local branch name; defaults to the checkout's HEAD. Returns the resolved commit. */
  resolveBase(input: { repoRoot: string; startFrom?: string }): Promise<string>;
  collect(input: { repoRoot: string; branch: string; base: string }): Promise<{
    commits: string;
    diffStat: string;
    /** Every path the branch adds, changes, deletes or renames since `base`. */
    changedFiles: string[];
    head: string;
  }>;
  /** A file's content at `rev`, or undefined when it is absent or unreadable. */
  fileAt(input: { repoRoot: string; rev: string; path: string }): Promise<string | undefined>;
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

export const gitWorkspace: Workspace = {
  repoRoot: (cwd) => git(["rev-parse", "--show-toplevel"], cwd),

  resolveBase: ({ repoRoot, startFrom }) => git(["rev-parse", startFrom ? `refs/heads/${startFrom}` : "HEAD"], repoRoot),

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

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
