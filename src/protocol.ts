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
  /** Review findings, when the work was a review. */
  findings?: string;
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

/** First message of the worker session; explicit `/skill:` invocation. */
export function workerPrompt(kind: WorkKind, task: string): string {
  switch (kind) {
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
        "Write the findings with citations to `docs/research/<short-slug>.md` and commit it.",
        "",
        task,
      ].join("\n");
  }
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
- Commit your work on the current branch. Do not push, merge or rebase other
  branches.
- When you are done, or cannot continue, call \`finish\` with an honest status
  and a short summary (what changed, how it was verified, what is left). Use
  \`needs_human\` when a decision, credential or manual step is required, and
  say exactly what you need.
- Messages starting with "[PI Lead]" come from the Lead (often relaying the
  user's answer). Continue the task with them and call \`finish\` again.
`;
