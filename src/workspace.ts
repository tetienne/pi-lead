import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How `gh pr checks --watch` settled. */
export type ChecksState = "pass" | "fail" | "timeout" | "none" | "error";

export type ChecksResult = {
  state: ChecksState;
  failed: { name: string; link: string }[];
  error?: string;
};

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
  /** Paths the branch adds (not modifies) since `base`, for the PR body's "tests added" line. */
  addedFiles(input: { repoRoot: string; branch: string; base: string }): Promise<string[]>;
  /** A file's content at `rev`, or undefined when it is absent or unreadable. */
  fileAt(input: { repoRoot: string; rev: string; path: string }): Promise<string | undefined>;
  /**
   * Push the branch and open a draft PR. Never throws: a missing `origin`, a
   * missing `gh`, or either command failing all come back as `{ error }`.
   * When the branch already has an open PR, only pushes and reuses its URL.
   * `remoteBranch` (default: `branch`) pushes the current branch onto that
   * remote branch instead: a quota reroute's new local branch fast-forwards
   * the PR's original head, instead of opening a second PR.
   */
  publish(input: { repoRoot: string; branch: string; baseBranch: string; title: string; body: string; remoteBranch?: string }): Promise<{ url?: string; error?: string }>;
  /** Whether the branch's head has a `.github/workflows` directory, i.e. whether CI runs on it at all. */
  hasWorkflows(input: { repoRoot: string; branch: string }): Promise<boolean>;
  /**
   * Watch a PR's checks with `gh pr checks --watch`, killed after `timeoutMs`
   * or when `signal` aborts, then read their final state. Never throws.
   */
  watchChecks(input: { repoRoot: string; pr: string; timeoutMs: number; signal?: AbortSignal }): Promise<ChecksResult>;
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** Run a command, killed after `timeoutMs` or when `signal` aborts; never throws. */
function runWatched(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

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

  async addedFiles({ repoRoot, branch, base }) {
    const names = await git(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...${branch}`], repoRoot);
    return names.split("\0").filter(Boolean);
  },

  async fileAt({ repoRoot, rev, path }) {
    // cat-file, not show: plumbing applies no textconv or other configured filter to the worker's blob.
    try {
      return await git(["cat-file", "blob", `${rev}:${path}`], repoRoot);
    } catch {
      return undefined;
    }
  },

  async publish({ repoRoot, branch, baseBranch, title, body, remoteBranch }) {
    const head = remoteBranch ?? branch;
    try {
      await git(["push", "-u", "origin", remoteBranch ? `${branch}:${remoteBranch}` : branch], repoRoot);
    } catch (error) {
      return { error: `git push failed: ${shortError(error)}` };
    }
    // A CI fix round, or a quota reroute pushing onto the same remote branch, reuses the open PR.
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "view", head, "--json", "url"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const url = (JSON.parse(stdout) as { url?: string }).url;
      if (url) return { url };
    } catch {
      // No open PR yet: create one below.
    }
    const bodyDir = await mkdtemp(join(tmpdir(), "pi-lead-pr-"));
    try {
      const bodyPath = join(bodyDir, "body.md");
      await writeFile(bodyPath, body);
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "create", "--draft", "--base", baseBranch, "--head", head, "--title", title, "--body-file", bodyPath],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      const url = stdout.trim().split("\n").at(-1);
      return url ? { url } : { error: "gh pr create produced no URL" };
    } catch (error) {
      return { error: `gh pr create failed: ${shortError(error)}` };
    } finally {
      await rm(bodyDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  async hasWorkflows({ repoRoot, branch }) {
    const listing = await git(["ls-tree", branch, "--", ".github/workflows"], repoRoot).catch(() => "");
    return listing.trim().length > 0;
  },

  async watchChecks({ repoRoot, pr, timeoutMs, signal }) {
    const deadline = Date.now() + timeoutMs;
    // Checks register a few seconds after the push: retry a "no checks yet" watch for up to 2 minutes.
    let registerWaitMs = 0;
    while (true) {
      if (signal?.aborted) return { state: "error", failed: [], error: "aborted" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state: "timeout", failed: [] };
      const watched = await runWatched("gh", ["pr", "checks", pr, "--watch", "--fail-fast"], repoRoot, signal, remaining);
      if (signal?.aborted) return { state: "error", failed: [], error: "aborted" };
      if (watched.timedOut) return { state: "timeout", failed: [] };
      if (/no checks reported/i.test(watched.stderr) && registerWaitMs < 120_000) {
        await sleep(15_000, signal).catch(() => undefined);
        registerWaitMs += 15_000;
        continue;
      }
      break;
    }
    // A settled watch can still report pending checks (fail-fast stops early): poll until none are pending.
    while (true) {
      if (signal?.aborted) return { state: "error", failed: [], error: "aborted" };
      if (Date.now() >= deadline) return { state: "timeout", failed: [] };
      try {
        const { stdout } = await execFileAsync("gh", ["pr", "checks", pr, "--json", "name,bucket,link"], {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        const checks = JSON.parse(stdout) as CheckBucket[];
        if (checks.length === 0) return { state: "none", failed: [] };
        const classified = classifyChecks(checks);
        if (classified.state !== "pending") return { state: classified.state, failed: classified.failed };
      } catch (error) {
        return { state: "error", failed: [], error: shortError(error) };
      }
      await sleep(15_000, signal).catch(() => undefined);
    }
  },

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
