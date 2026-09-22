import { readFile } from "node:fs/promises";

import type { LeadConfig } from "./config.ts";
import type { WorkKind, WorkerVerdict } from "./jev.ts";

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
};

/** Written by the worker's `finish` tool. */
export type WorkerResult = {
  version: 1;
  id: string;
  status: WorkerVerdict;
  summary: string;
  /** Review findings, when the work was a review. */
  findings?: string;
};

export const WORKER_STATUSES = ["done", "partial", "blocked", "needs_human"] as const satisfies readonly WorkerVerdict[];

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function parseWorkerResult(value: unknown, id: string): WorkerResult {
  const result = value as Partial<WorkerResult> | undefined;
  if (
    result?.version !== 1 ||
    result.id !== id ||
    !WORKER_STATUSES.includes(result.status as WorkerVerdict) ||
    typeof result.summary !== "string" ||
    (result.findings !== undefined && typeof result.findings !== "string")
  ) {
    throw new Error("worker result is malformed");
  }
  return result as WorkerResult;
}

/** Matt Pocock skills each kind of worker loads. */
export const WORKER_SKILLS: Record<WorkKind, readonly string[]> = {
  implement: ["implement", "tdd", "code-review", "codebase-design", "domain-modeling"],
  debug: ["diagnosing-bugs", "tdd", "codebase-design"],
  review: ["code-review", "codebase-design"],
  research: ["codebase-design"],
};

/** First message of the worker session; explicit `/skill:` invocation. */
export function workerPrompt(kind: WorkKind, task: string): string {
  switch (kind) {
    case "implement":
      return `/skill:implement ${task}`;
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
- Commit your work on the current branch. Do not push, merge or rebase other
  branches.
- When you are done, or cannot continue, call \`finish\` exactly once with an
  honest status and a short summary (what changed, how it was verified, what
  is left). Use \`needs_human\` when a decision, credential or manual step is
  required.
`;
