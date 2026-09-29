import type { QuotaError } from "./quota.ts";

export type WorkKind = "implement" | "prototype" | "debug" | "review" | "research";
/** What a worker reports in `finish`, and what the Lead hears once host evidence has capped it. */
export type WorkerVerdict = "done" | "partial" | "blocked" | "needs_human";

/**
 * Set in every Pi that PI Lead starts (`worker`, `sub-agent`); the Lead extension
 * stays inert wherever it is set, so a worker never becomes a second Lead.
 */
export const ROLE_ENV = "PI_LEAD_ROLE";

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
  /** Steer the worker when it keeps repeating a failing command. Absent means on. */
  stuckDetection?: boolean;
  /** `--model` value for code-review's sub-agents; absent: Pi's default model. */
  reviewModel?: string;
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
};

/** Work kinds whose worker changes code, and so should run its tests. */
export const WRITES_CODE: readonly WorkKind[] = ["implement", "prototype", "debug"];

/** Kinds that push, open a draft PR and watch its CI once they settle `done`: not prototype or review. */
export const PUBLISHED_KINDS: readonly WorkKind[] = ["implement", "debug", "research"];

export const WORKER_STATUSES = ["done", "partial", "blocked", "needs_human"] as const satisfies readonly WorkerVerdict[];

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
    (result.quota !== undefined &&
      (typeof result.quota?.message !== "string" ||
        (result.quota.retryAfterMinutes !== undefined &&
          !(Number.isFinite(result.quota.retryAfterMinutes) && result.quota.retryAfterMinutes >= 0))))
  ) {
    throw new Error("worker result is malformed");
  }
  return result as WorkerResult;
}

/** Where the worker pushes its ticket and opens its draft PR; the worker watches that PR's CI itself. */
export type PublishTarget = { baseBranch: string; remoteBranch: string; title: string };

/** One shell word, never expanded: for the launch script, and for the commands the worker pastes into its shell. */
export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/** First message of the worker session; explicit `/skill:` invocation. */
export function workerPrompt(kind: WorkKind, task: string, publish?: PublishTarget): string {
  const base = ((): string => {
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
          "First list the sub-questions the question breaks into; answer each with a citation to a primary source,",
          "or mark it \"unknown\" with what was tried. Do not answer from memory. Stop when every sub-question is",
          "answered or marked unknown.",
          "Write the findings with citations to `docs/research/<short-slug>.md` and commit it.",
          "",
          task,
        ].join("\n");
    }
  })();
  if (!publish || !PUBLISHED_KINDS.includes(kind)) return base;
  return [
    base,
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

/**
 * How the Lead and its workers run the sub-agents Matt's skills ask for:
 * one non-interactive Pi per sub-agent in a Herdr pane beside the caller.
 * `wait-output` matches line by line, and the typed command line never starts
 * with the marker: only the `echo` output does.
 */
export const subAgentRecipe = (reviewModel?: string) => `## Sub-agents

When a skill says to spawn, dispatch or fire a sub-agent (code-review's two
axes, grilling's fact-finding, wayfinder's research,
improve-codebase-architecture's exploration, codebase-design's
design-it-twice), run each one as a non-interactive Pi in a Herdr pane beside
you:

1. Check \`test "\${HERDR_ENV:-}" = 1\`. If it fails, Herdr is unavailable: do
   the sub-agents' steps yourself, one after the other, in this context, and
   say so in your output.
2. Write the sub-agent's complete brief to \`<dir>/prompt.md\` in a fresh
   \`mktemp -d\` directory: it sees nothing of your context.
3. \`herdr pane split --current --direction right --cwd "$PWD" --env ${ROLE_ENV}=sub-agent --no-focus\`
   (\`down\` if your pane is narrow), and read the new pane's id from
   \`.result.pane.pane_id\` in the JSON it prints.
4. \`herdr pane run <pane-id> "pi --print --no-session @<dir>/prompt.md > <dir>/report.md 2>&1; echo sub-agent-finished"\`,
   with \`<dir>\` written out. Start every sub-agent the step asks for before
   waiting on any.
5. \`herdr pane wait-output <pane-id> --source recent-unwrapped --regex '^sub-agent-finished' --timeout 1800000\`.
   On a timeout, look with \`herdr pane read <pane-id> --source recent-unwrapped --lines 120\`
   before deciding.
6. Read \`<dir>/report.md\` (the sub-agent's final answer, or its error),
   then \`herdr pane close <pane-id>\`, and carry on with the skill.${reviewModel ? reviewModelNote(reviewModel) : ""}`;

const reviewModelNote = (reviewModel: string) => `

For code-review's sub-agents only (its Standards and Spec axes), step 4's
command is \`pi --print --no-session --model ${shellQuote(reviewModel)} @<dir>/prompt.md > <dir>/report.md 2>&1; echo sub-agent-finished\`.
Every other skill's sub-agents keep the command without \`--model\`. If a
code-review sub-agent's report is an error (quota, auth, unknown model), do not
rerun it on another model: say in your output and in the finish summary that
the review sub-agents could not run.`;

export const workerRules = (reviewModel?: string) => `## PI Lead worker

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
- When a skill says to confirm something with the user (a seam, an
  interface), decide from the code and say so in your finish summary. Use
  \`needs_human\` only for what the code cannot answer.

${subAgentRecipe(reviewModel)}`;
