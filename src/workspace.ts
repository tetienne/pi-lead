import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Each worker gets a self-contained clone that is mounted into its VM. The
 * guest owns that clone completely, including `.git/config`, so the host never
 * runs git *inside* it: it only fetches from it into the real repository.
 * `git-upload-pack` ignores repository-local hooks such as
 * `uploadpack.packObjectsHook`, which is what makes fetching safe.
 */
export type Workspace = {
  repoRoot(cwd: string): Promise<string>;
  /** `startFrom` is a local branch name; defaults to the checkout's HEAD. */
  create(input: { repoRoot: string; path: string; branch: string; startFrom?: string }): Promise<{ base: string }>;
  collect(input: { repoRoot: string; path: string; branch: string; base: string }): Promise<{
    commits: string;
    diffStat: string;
  }>;
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

  async create({ repoRoot, path, branch, startFrom }) {
    const base = await git(["rev-parse", startFrom ? `refs/heads/${startFrom}` : "HEAD"], repoRoot);
    // --no-hardlinks: the guest must not be able to rewrite host object files.
    await git(["clone", "--quiet", "--no-hardlinks", "--no-tags", repoRoot, path]);
    // Keep origin/* refs so reviews can compare branches, but point the remote
    // nowhere: the host checkout is not reachable from the guest anyway.
    await git(["remote", "set-url", "origin", "file:///nonexistent"], path);
    await git(["checkout", "--quiet", "-b", branch, startFrom ? `origin/${startFrom}` : base], path);
    await git(["config", "user.name", "PI Lead worker"], path);
    await git(["config", "user.email", "pi-lead-worker@localhost"], path);
    return { base };
  },

  async collect({ repoRoot, path, branch, base }) {
    await git(["fetch", "--quiet", "--no-tags", path, `+refs/heads/${branch}:refs/heads/${branch}`], repoRoot);
    const [commits, diffStat] = await Promise.all([
      git(["log", "--oneline", `${base}..${branch}`], repoRoot),
      git(["diff", "--stat", `${base}...${branch}`], repoRoot),
    ]);
    return { commits, diffStat };
  },

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
