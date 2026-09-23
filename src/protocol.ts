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
  /** Host path of the disposable clone mounted at /workspace. */
  clonePath: string;
  /** Host path the worker writes its `WorkerResult` to (outside the clone). */
  resultPath: string;
  sandbox: LeadConfig["sandbox"];
  jev: LeadConfig["jev"];
  /** Host directory with the project's mise toolchains, mounted read-only at /opt/mise. */
  toolchainCache?: string;
  /** Host directories mounted read-only at the same path in the guest (skill folders). */
  readonlyMounts: string[];
  /** Send an unverified `done` back to the worker once (config `steerUnverifiedDone`); unset means true. */
  steerUnverifiedDone?: boolean;
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
  /** Changes left in the clone because committing them failed. */
  uncommitted?: boolean;
  /** Written by the worker extension: the last test-like shell command and its exit code. */
  lastTest?: LastTest;
};

/**
 * Recorded by the host-side bash wrapper, so the model cannot make it up; but
 * the guest controls the repository, so it is a signal, not proof. `exitCode`
 * is -1 when the command did not complete (timeout, abort).
 */
export type LastTest = { command: string; exitCode: number };

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
    (result.lastTest !== undefined &&
      (typeof result.lastTest?.command !== "string" || !Number.isInteger(result.lastTest.exitCode))) ||
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

- Your tools run in a Gondolin VM. The repository is a disposable clone at
  /workspace, on the branch you were given. Branches from the original
  checkout are available as \`origin/<name>\`.
- Network access is filtered; if a request is refused, work without it or
  report it.
- Project toolchains (mise) are preinstalled and read-only; if one is missing,
  report it instead of working around it.
- Commit your work on the current branch. Do not push, merge or rebase other
  branches.
- When you are done, or cannot continue, call \`finish\` with an honest status
  and a short summary (what changed, how it was verified, what is left). Use
  \`needs_human\` when a decision, credential or manual step is required, and
  say exactly what you need.
- Messages starting with "[PI Lead]" come from the Lead (often relaying the
  user's answer). Continue the task with them and call \`finish\` again.
`;
