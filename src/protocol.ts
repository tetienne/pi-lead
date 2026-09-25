import { readFile } from "node:fs/promises";

import type { LeadConfig } from "./config.ts";
import type { WorkKind, WorkerVerdict } from "./jev.ts";
import type { QuotaError } from "./quota.ts";

/** Written by the Lead, read by the worker extension (`--pi-lead-task`). */
export type WorkerTask = {
  version: 1;
  id: string;
  kind: WorkKind;
  title: string;
  task: string;
  branch: string;
  /** Host path of the worker's own git worktree; its tools run there. */
  worktreePath: string;
  /** Host path the worker writes its `WorkerResult` to (outside the worktree). */
  resultPath: string;
  /** Set for an implement worker built on a scout's brief. */
  allowedFiles?: string[];
  /** The scout's own test files: must not be changed, only made to pass. */
  protectedFiles?: string[];
  jev: LeadConfig["jev"];
  /** Steer the worker when it keeps repeating a failing command. Absent means on. */
  stuckDetection?: boolean;
  /**
   * The project's `verify` command (trusted project config only), run by the
   * worker extension on the host's behalf when code work finishes.
   */
  verify?: string;
  verifyTimeoutMinutes?: number;
};

/** Written by the worker's `finish` tool. */
export type WorkerResult = {
  version: 1;
  id: string;
  /** 1 for the first `finish`, +1 each time the worker finishes again after a message. */
  seq: number;
  status: WorkerVerdict;
  summary: string;
  /** Review findings, when the work was a review; for a scout, the brief for the implementer. */
  findings?: string;
  /** Written by a scout's `finish`: exact repo-relative paths the implementer may change or create. */
  allowedFiles?: string[];
  /**
   * Written by the worker extension, not by `finish`: the model stopped on a
   * provider error. `quota` is set when that error is an exhausted allowance.
   */
  modelError?: string;
  quota?: QuotaError;
  /** Changes left in the worktree because committing them failed. */
  uncommitted?: boolean;
  /** Written by the worker extension, not by `finish`: the run of `WorkerTask.verify`. */
  verification?: Verification;
};

/**
 * The task's `verify` command, run by the worker extension (host-side code)
 * in the worker's worktree after the model's last commit; the model cannot
 * choose or skip it. `exitCode` is -1 when it did not complete (timeout,
 * error). The worker controls the repository, so `outputTail` is
 * worker-produced text.
 */
export type Verification = { command: string; exitCode: number; outputTail: string; ms: number };

/** Work kinds whose worker changes code, and so should run its tests. */
export const WRITES_CODE: readonly WorkKind[] = ["implement", "prototype", "debug"];

/** Kinds that push, open a draft PR and watch its CI once they settle `done`: not prototype, review or scout. */
export const PUBLISHED_KINDS: readonly WorkKind[] = ["implement", "debug", "research"];

export const WORKER_STATUSES = ["done", "partial", "blocked", "needs_human"] as const satisfies readonly WorkerVerdict[];

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function parseWorkerResult(value: unknown, id: string): WorkerResult {
  const result = value as Partial<WorkerResult> | undefined;
  if (
    result?.version !== 1 ||
    result.id !== id ||
    !Number.isInteger(result.seq) ||
    (result.seq as number) < 1 ||
    !WORKER_STATUSES.includes(result.status as WorkerVerdict) ||
    typeof result.summary !== "string" ||
    (result.findings !== undefined && typeof result.findings !== "string") ||
    (result.allowedFiles !== undefined && (!Array.isArray(result.allowedFiles) || result.allowedFiles.some((f) => typeof f !== "string"))) ||
    (result.modelError !== undefined && typeof result.modelError !== "string") ||
    (result.uncommitted !== undefined && typeof result.uncommitted !== "boolean") ||
    (result.verification !== undefined &&
      (typeof result.verification?.command !== "string" ||
        !Number.isInteger(result.verification.exitCode) ||
        typeof result.verification.outputTail !== "string" ||
        !(Number.isFinite(result.verification.ms) && result.verification.ms >= 0))) ||
    (result.quota !== undefined &&
      (typeof result.quota?.message !== "string" ||
        (result.quota.retryAfterMinutes !== undefined &&
          !(Number.isFinite(result.quota.retryAfterMinutes) && result.quota.retryAfterMinutes >= 0))))
  ) {
    throw new Error("worker result is malformed");
  }
  return result as WorkerResult;
}

/** A scout's brief for the implementer that builds on its branch. */
export type WorkerBrief = { allowedFiles: string[]; protectedFiles: string[]; text: string };

/** Where the worker pushes its ticket and opens its draft PR; the worker watches that PR's CI itself. */
export type PublishTarget = { baseBranch: string; remoteBranch: string; title: string };

// The Lead model writes the title; the worker pastes the command into its shell.
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** First message of the worker session; explicit `/skill:` invocation. */
export function workerPrompt(kind: WorkKind, task: string, brief?: WorkerBrief, publish?: PublishTarget): string {
  const base = ((): string => {
    switch (kind) {
      case "scout":
        return [
          `You prepare this ticket for a cheaper implementer; do not implement it: ${task}`,
          "",
          "Read the ticket and the code. Find existing helpers, types and patterns the change must reuse.",
          "Write failing tests for the acceptance criteria at the public seams, copying the style of an existing test.",
          "Run them and confirm they fail for the expected reason. Commit them.",
          "If the ticket cannot be tested (docs, config), write no test.",
          "Call `finish` with `allowedFiles`: exact repo-relative paths the implementer may change or create (source",
          "files, plus the lockfile only if a dependency must change); do not list your own test files; no directories.",
          "And `findings`: the brief (helpers to reuse with paths, the seam and interface decided, the test command",
          "that runs your tests, anything the implementer must not do).",
          "Use `needs_human` when the code cannot settle a decision.",
        ].join("\n");
      case "implement":
        return `/skill:implement ${task}`;
      case "prototype":
        return `/skill:prototype ${task}`;
      case "debug":
        return `/skill:diagnosing-bugs ${task}\n\nOnce the root cause is found, fix it with a regression test.`;
      case "review":
        return `/skill:code-review ${task}\n\nDo not change code. Put the full review in the \`findings\` argument of \`finish\`.`;
      case "research":
        return [
          "Research the following question against primary sources (official docs, source code, specifications).",
          "First list the sub-questions the question breaks into; answer each with a citation to a primary source,",
          "or mark it \"unknown\" with what was tried. Do not answer from memory. Stop when every sub-question is",
          "answered or marked unknown.",
          "Write the findings with citations to `docs/research/<short-slug>.md` and commit it.",
          "",
          task,
        ].join("\n");
    }
  })();
  const withBrief = !brief
    ? base
    : [
        base,
        "",
        "## Scout brief",
        `Allowed files (change or create only these): ${brief.allowedFiles.join(", ")}`,
        `Protected test files (do not change; make them pass): ${brief.protectedFiles.join(", ")}`,
        "",
        brief.text,
      ].join("\n");
  if (!publish || !PUBLISHED_KINDS.includes(kind)) return withBrief;
  return [
    withBrief,
    "",
    "## Publishing",
    `When the work is committed: push it with \`git push -u origin HEAD:${publish.remoteBranch}\`, open a draft PR against`,
    `\`${publish.baseBranch}\` with \`gh pr create --draft --base ${publish.baseBranch} --head ${publish.remoteBranch} --title ${shellQuote(publish.title)} --body ...\``,
    "(if a PR already exists for that branch, reuse it), then wait for CI with",
    `\`gh pr checks ${publish.remoteBranch} --watch\`. Checks can take a few seconds to register: if it reports none yet,`,
    "wait and retry briefly before concluding the repository runs no checks.",
    "If a check fails, read it with `gh run view <run-id> --log-failed`, fix it, commit, push and watch again. Call",
    "`finish` only once CI is green (or the repository runs no checks); if you cannot get it green, call `finish` with",
    "status `partial` and say why. Put the PR URL in your summary.",
  ].join("\n");
}

export const WORKER_RULES = `
## PI Lead worker

You are a worker delegated by the PI Lead. You run unattended unless a human
opens your tab.

- Your working directory is your own git worktree of the repository, on the
  branch you were given. Other local branches stay visible for reference:
  never switch, reset, rebase or delete them, and never touch git config.
  Never create another worktree, clone or branch, even if the project's
  instructions say to; only your own worktree is kept.
- Commit your work on the current branch. Do not merge, rebase or push any
  other branch; push only as your task's "Publishing" section says.
- When you are done, or cannot continue, call \`finish\` with an honest status
  and a short summary (what changed, how it was verified, what is left). Use
  \`needs_human\` when a decision, credential or manual step is required, and
  say exactly what you need.
- Messages starting with "[PI Lead]" come from the Lead (often relaying the
  user's answer). Continue the task with them and call \`finish\` again.
- You run unattended: when a skill says to confirm something with the user
  (a seam, an interface), use the scout brief when there is one, otherwise
  decide from the code and say so in your finish summary. Use \`needs_human\`
  only for what the code cannot answer.
`;
