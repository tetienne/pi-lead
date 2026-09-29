import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One check as `gh pr checks --json name,bucket,link` reports it. */
export type CheckBucket = { name: string; bucket: string; link: string };

/**
 * Classify a PR's checks. gh sorts every check into one of five buckets:
 * `pass`, `skipping`, `pending`, `fail` and `cancel`. `fail` and `cancel` both
 * count as failed (checked first, since a fail-fast watch can still leave
 * others pending); otherwise any `pending` means the run isn't settled yet.
 */
export function classifyChecks(checks: CheckBucket[]): { state: "pass" | "pending" | "fail"; failed: { name: string; link: string }[] } {
  const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map(({ name, link }) => ({ name, link }));
  if (failed.length) return { state: "fail", failed };
  return { state: checks.some((check) => check.bucket === "pending") ? "pending" : "pass", failed: [] };
}

/** Failed checks as `name (link)`, one per entry. Check names and links are the repository's: untrusted text. */
export const checkList = (failed: readonly { name: string; link: string }[]) => failed.map((check) => `${check.name} (${check.link})`);

/** gh's merge methods, in the order its own `gh pr merge` prompt offers them. */
export const MERGE_METHODS = ["merge", "rebase", "squash"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** A PR as `gh pr view --json number,url,state,isDraft,headRefOid,baseRefName` reports it. */
export type PrView = { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; head: string; base: string };

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
  /**
   * One non-watching read of the worker's own draft PR and its checks. Never
   * throws: `state` is `none` both when the branch has no open PR and when a
   * PR exists but runs no checks; any other `gh` failure is `error`.
   */
  prChecks(input: { repoRoot: string; branch: string }): Promise<{
    url?: string;
    /** The commit the PR's head points at (`headRefOid`): its checks are for that commit only. */
    head?: string;
    state: "pass" | "fail" | "pending" | "none" | "error";
    failed: { name: string; link: string }[];
    error?: string;
  }>;
  /** `gh pr view <pr>`; `pr` is a number, URL or branch. Never throws. */
  prView(input: { repoRoot: string; pr: string }): Promise<PrView | { error: string }>;
  /** `gh pr ready <pr>`: GitHub refuses to merge a draft. */
  prReady(input: { repoRoot: string; pr: string }): Promise<{ error?: string }>;
  /**
   * `gh pr update-branch <pr>`: merges the base into the PR's branch on GitHub
   * (a no-op when it is not behind). gh says "Cannot update PR branch due to
   * conflicts" and exits non-zero on a conflict.
   */
  updateBranch(input: { repoRoot: string; pr: string }): Promise<{ state: "updated" | "conflict" | "error"; error?: string }>;
  /** `gh pr checks <pr> --watch --fail-fast`: returns once no check is pending or one failed; read the result with `prChecks`. */
  watchChecks(input: { repoRoot: string; pr: string }): Promise<void>;
  /** The merge methods the repository allows (`gh repo view --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed`), in gh's order. */
  mergeMethods(repoRoot: string): Promise<{ methods: MergeMethod[] } | { error: string }>;
  /**
   * `gh pr merge <pr> --<method> --match-head-commit <head>`: GitHub refuses
   * if the head moved. No `--delete-branch`: the repository's own
   * delete-on-merge setting decides about the remote branch.
   */
  mergePr(input: { repoRoot: string; pr: string; method: MergeMethod; head: string }): Promise<{ error?: string }>;
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
  // With --json, gh prints the checks and exits 0 whatever their state; with no checks at all it fails with its own message.
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

const ghIn = (repoRoot: string, args: string[], timeout = 60_000): Promise<GhRun> =>
  execFileAsync("gh", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout, maxBuffer: 16 << 20 }).then(
    ({ stdout, stderr }) => ({ stdout, stderr }),
    (error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout, stderr: error.stderr, error }),
  );

const ghDone = (run: GhRun): { error?: string } => (run.error ? { error: ghError(run) } : {});

/** CI can take long; a watch that outlasts this counts as pending. */
const WATCH_TIMEOUT_MS = 60 * 60_000;

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

  async prChecks({ repoRoot, branch }) {
    const gh = (args: string[]) => ghIn(repoRoot, args);
    const view = await gh(["pr", "view", branch, "--json", "url,headRefOid"]);
    if (view.error) {
      if (/no pull requests found/i.test(view.stderr ?? "")) return { state: "none", failed: [] };
      return { state: "error", failed: [], error: ghError(view) };
    }
    let pr: { url?: string; headRefOid?: string };
    try {
      pr = (JSON.parse(view.stdout ?? "") as typeof pr | null) ?? {};
    } catch (error) {
      return { state: "error", failed: [], error: shortError(error) };
    }
    if (!pr.url) return { state: "none", failed: [] };
    return {
      url: pr.url,
      ...(pr.headRefOid ? { head: pr.headRefOid } : {}),
      ...readChecks(await gh(["pr", "checks", branch, "--json", "name,bucket,link"])),
    };
  },

  async prView({ repoRoot, pr }) {
    const run = await ghIn(repoRoot, ["pr", "view", pr, "--json", "number,url,state,isDraft,headRefOid,baseRefName"]);
    if (run.error) return { error: ghError(run) };
    try {
      const view = JSON.parse(run.stdout ?? "") as { number: number; url: string; state: PrView["state"]; isDraft: boolean; headRefOid: string; baseRefName: string };
      return { number: view.number, url: view.url, state: view.state, isDraft: view.isDraft, head: view.headRefOid, base: view.baseRefName };
    } catch (error) {
      return { error: shortError(error) };
    }
  },

  prReady: async ({ repoRoot, pr }) => ghDone(await ghIn(repoRoot, ["pr", "ready", pr])),

  async updateBranch({ repoRoot, pr }) {
    const run = await ghIn(repoRoot, ["pr", "update-branch", pr]);
    if (!run.error) return { state: "updated" };
    return /due to conflicts/i.test(run.stderr ?? "") ? { state: "conflict" } : { state: "error", error: ghError(run) };
  },

  async watchChecks({ repoRoot, pr }) {
    // Exits 1 on a failed check, 8 on pending: the outcome is read with `prChecks` afterwards.
    await ghIn(repoRoot, ["pr", "checks", pr, "--watch", "--fail-fast"], WATCH_TIMEOUT_MS);
  },

  async mergeMethods(repoRoot) {
    const run = await ghIn(repoRoot, ["repo", "view", "--json", "mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed"]);
    if (run.error) return { error: ghError(run) };
    try {
      const repo = JSON.parse(run.stdout ?? "") as { mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean; squashMergeAllowed?: boolean };
      const allowed = { merge: repo.mergeCommitAllowed, rebase: repo.rebaseMergeAllowed, squash: repo.squashMergeAllowed };
      return { methods: MERGE_METHODS.filter((method) => allowed[method] === true) };
    } catch (error) {
      return { error: shortError(error) };
    }
  },

  mergePr: async ({ repoRoot, pr, method, head }) =>
    ghDone(await ghIn(repoRoot, ["pr", "merge", pr, `--${method}`, "--match-head-commit", head])),

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};
