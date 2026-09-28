import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { LeadConfig, Tier } from "./config.ts";
import type { Herdr } from "./herdr.ts";
import { DEFAULT_TIER, VERDICT_ORDER, type Judge, type WorkKind, type WorkerVerdict } from "./jev.ts";
import { resolveRoute, type ModelRef, type WorkerRoute } from "./model-routing.ts";
import { parseWorkerResult, PUBLISHED_KINDS, ROLE_ENV, shellQuote, workerPrompt, WRITES_CODE, type WorkerResult, type WorkerTask } from "./protocol.ts";
import { providerOf, quotaPauseMinutes, type QuotaError } from "./quota.ts";
import { sensitivePatterns } from "./sensitive-paths.ts";
import { attentionNotice, plainTitle, stateLabels, tabLabel } from "./worker-display.ts";
import { mergeOne, type MergeTarget } from "./merge.ts";
import { checkList, type MergeMethod, type Workspace } from "./workspace.ts";

export type DelegateParams = {
  kind: WorkKind;
  title: string;
  task: string;
  /** Local branch to start from (reviews start from the branch under review). */
  startFrom?: string;
};

/** What the Lead's session knows when a task is delegated. */
export type DelegateIO = {
  cwd: string;
  lead: ModelRef | undefined;
  available: readonly ModelRef[];
  /** Whether the Lead trusts this project; its workers then trust their worktrees too. */
  projectTrusted: boolean;
};

export type WorkerState =
  | "starting"
  | "running"
  | "waiting" // stopped on needs_human / partial / blocked, tab open, can be messaged
  | "done"
  | "failed"
  | "stopped";

export type WorkerInfo = {
  id: string;
  title: string;
  kind: WorkKind;
  state: WorkerState;
  branch?: string;
  route: WorkerRoute;
  /** A worktree workspace open in Herdr for this worker. */
  tabOpen: boolean;
  /** Verdict of the last finish, which says why a waiting worker waits. */
  verdict?: WorkerVerdict;
  /** The green PR of a done worker, whose tab stays open until the PR is merged. */
  pr?: string;
};

export type DelegateOutcome = {
  worker: WorkerInfo;
  status: WorkerVerdict | "failed" | "stopped";
  /** Delivered to the Lead model as a message. */
  text: string;
  details: {
    reported?: WorkerVerdict;
    jevVerdict?: WorkerVerdict;
    quota?: QuotaError;
    /** Sensitive path patterns the branch touches; a review hint only, never a status change. */
    sensitive?: string[];
    /** The worker's own draft PR for a finished ticket. */
    pr?: string;
    /** What the Lead's transcript shows as a card (the model reads `text`). */
    card?: ReportCard;
  };
};

/**
 * A result as the user sees it. Host data, except `summary`, which the
 * worker wrote: the card always shows part of it,
 * labelled untrusted, so the user sees what the model acts on.
 */
export type ReportCard = {
  kind: WorkKind;
  title: string;
  model: string;
  thinking: string;
  /** This run: since the worker last started running, or since delegation. */
  elapsedMs: number;
  branch?: string;
  commits: number;
  /** git's `N files changed, X insertions(+), Y deletions(-)`. */
  diff?: string;
  /** CI status of the draft PR's head (`none`, `passed`, `failed (N checks)`, `pending`, `not checked (…)`). */
  ci?: string;
  /**
   * The error that ended a failed worker (untrusted). A finished worker's own
   * words are the report's `<worker-report untrusted>` block, which the card
   * shows from the text the model reads, so they are not stored twice.
   */
  summary?: string;
  /** Host-written next steps of the report. */
  next: string[];
};

export type StartResult =
  | { status: "started"; worker: WorkerInfo; text: string }
  | { status: "failed"; text: string };

export type WorkerCommand = (input: {
  taskPath: string;
  prompt: string;
  route: WorkerRoute;
  label: string;
  /** The Lead's trust in the project, which the worker's Pi applies to its worktree. */
  projectTrusted: boolean;
}) => string[];

export type DelegateDeps = {
  config: LeadConfig;
  judge: Judge;
  herdr: Herdr | undefined;
  workspace: Workspace;
  workerCommand: WorkerCommand;
  stateRoot: string;
  /** Called for every result: first finish, each later finish, failures and stops. */
  onOutcome(outcome: DelegateOutcome): void;
  /** Short progress lines, one per event (started, retried, rerouted), for the Lead's transcript. */
  onProgress?(text: string): void;
  /** The end of a `merge` run: what merged, where it stopped and why. */
  onMergeReport?(text: string): void;
  /** How long a merge waits for checks to register on a PR's new head (default 15 s). */
  checksGraceMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  /** Whether the Lead process that wrote a task record still runs (tests fake it). */
  processAlive?(pid: number): boolean;
  /** This Lead's pid, which its task records carry (tests fake it). */
  pid?: number;
  now?(): number;
};

/**
 * `tab.json` in each task dir, written by the Lead that owns it. A later Lead
 * of the same repository uses it to adopt the workers of a Lead that crashed
 * or was killed while their Pi still runs, and removes the worktrees of the
 * others.
 */
type TabRecord = {
  version: 1;
  leadPid: number;
  createdAt: string;
  workspaceId?: string;
  paneId?: string;
  /** A failed worker whose task dir is kept for inspection (keepFailedWorkers). */
  failed?: boolean;
  /** Everything a later Lead needs to watch the worker as its own; set once its pane runs. */
  worker?: AdoptableWorker;
};

/** The watcher's view of a worker, as a later Lead rebuilds it. `repo`, the main checkout, keys adoption to its repository. */
const ADOPTED = [
  "id", "title", "kind", "state", "verdict", "branch", "route", "params", "difficulty", "repoRoot", "repo", "base", "originBase",
  "baseBranch", "remoteBranch", "handledSeq", "attempts", "delegatedAt", "runningSince", "resumed", "reroutes", "sentBack",
] as const satisfies readonly (keyof Worker)[];
type AdoptableWorker = Pick<Worker, (typeof ADOPTED)[number]>;

const RECORD = "tab.json";

/** Replace a task record in one step (write aside, then rename), so a reading Lead never sees half of it. */
async function replaceRecord(dir: string, record: unknown): Promise<void> {
  const aside = join(dir, `${RECORD}.${process.pid}.tmp`);
  await writeFile(aside, JSON.stringify(record, null, 2));
  await rename(aside, join(dir, RECORD));
}

/** States whose Pi a later Lead can keep watching. */
const ADOPTABLE: readonly WorkerState[] = ["starting", "running", "waiting"];

/** Model changes a single task may go through on quota errors. */
const MAX_REROUTES = 3;

const RESUME_NOTE =
  "\n\nA previous PI Lead worker ran out of model quota on this task. Its work so far is committed on the current branch: review it with git log and continue from there.";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Worker = Omit<WorkerInfo, "tabOpen"> & {
  params: DelegateParams;
  io: DelegateIO;
  difficulty: number | undefined;
  /** Set on the first launch that publishes: the remote branch to push to, reused across a reroute so it lands on the same PR. */
  remoteBranch?: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone(): void;
  taskDir?: string;
  worktreePath?: string;
  repoRoot?: string;
  /** The repository's main checkout, which keys adoption by a later Lead. */
  repo?: string;
  base?: string;
  /** The ticket's original base commit, set once at first launch. */
  originBase?: string;
  /** The branch the checkout was on when the ticket was first delegated; the PR base. Undefined on a detached HEAD. */
  baseBranch?: string;
  workspaceId?: string;
  paneId?: string;
  resultPath?: string;
  exitPath?: string;
  lastSeq: number;
  /** The last finish fully handled (reported, or sent back): a Lead that adopts the worker settles any later one. */
  handledSeq: number;
  attempts: number;
  createdAt?: string;
  /** When the task was delegated, and when the worker last started running (a relayed answer, a reroute): the card times this run. */
  delegatedAt: number;
  runningSince?: number;
  /** The label Herdr last took for the worktree workspace, so a state change renames it only when it changes. */
  tabLabel?: string;
  /** The worker's pending worktree renames, in order. */
  renaming?: Promise<void>;
  /** The worker's pending task record writes, in order. */
  recording?: Promise<void>;
  /** Herdr agent name: set once, tried at most twice per tab. */
  named: boolean;
  renameTries: number;
  /** Continues the branch of an attempt that ran out of quota. */
  resumed: boolean;
  reroutes: number;
  /** A CI partial already went back to the worker: the next one reaches the Lead. */
  sentBack: boolean;
  /** Paths the branch changed since its base, as of its last finish (worker-chosen names). */
  changedFiles?: string[];
  /** Its tab is closed on purpose (merged, stopped after done): the watcher ends without a report. */
  retired?: boolean;
};

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/**
 * Invisible characters (zero-width, soft hyphen, fillers, bidi marks,
 * variation selectors, Unicode tags) that can carry text the model reads but
 * the user never sees. An emoji's own presentation selector is kept.
 */
export const INVISIBLE = /(?<!\p{Extended_Pictographic})[\ufe0e\ufe0f]|(?![\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}|\u061c/gu;

/**
 * Worker text as the report carries it, for the model and the card alike:
 * without invisible characters, and never opening or closing the report's
 * untrusted block, look-alikes of the marker included.
 */
export function unmarked(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[<＜﹤]\s*(\/?)\s*(worker[\s_\u2010-\u2015-]{0,3}report)/giu, "‹$1$2");
}

export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes("..") && !name.endsWith("/") &&
    !name.endsWith(".lock") && !name.includes("//");
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Delegation is asynchronous: `start` returns as soon as the worker is starting,
 * the Lead keeps talking with the user, and every result is pushed through
 * `onOutcome`. Workers stopped on a question stay reachable through `message`.
 */
export function createDelegator(deps: DelegateDeps) {
  const workers = new Map<string, Worker>();
  const pollMs = deps.pollMs ?? 1_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const progress = (text: string) => {
    try {
      deps.onProgress?.(text);
    } catch {
      // A stale Lead session must not take the watcher down.
    }
  };
  const report = (outcome: DelegateOutcome) => {
    try {
      deps.onOutcome(outcome);
    } catch {
      // Same: a replaced or closed Lead session can throw on delivery.
    }
  };

  const info = (worker: Worker): WorkerInfo => ({
    id: worker.id,
    title: worker.title,
    kind: worker.kind,
    state: worker.state,
    route: worker.route,
    tabOpen: worker.workspaceId !== undefined,
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(worker.verdict ? { verdict: worker.verdict } : {}),
    ...(worker.pr ? { pr: worker.pr } : {}),
  });

  const now = deps.now ?? Date.now;

  /**
   * Providers whose included quota ran out, until when. Workers are routed
   * around them; nothing ever falls back to a paid balance, since Pi does not
   * retry quota errors and PI Lead only moves to another configured model.
   */
  const exhausted = new Map<string, number>();
  const isExhausted = (provider: string) => (exhausted.get(provider) ?? 0) > now();
  const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
  const exhaustedNote = () => {
    const providers = [...exhausted].filter(([provider]) => isExhausted(provider));
    return providers.length ? `quota exhausted: ${providers.map(([provider, until]) => `${provider} until ~${clock(until)}`).join(", ")}` : undefined;
  };
  /** The models a worker may use now: the session's, minus exhausted providers. */
  const routable = (io: DelegateIO) => ({
    lead: io.lead && !isExhausted(io.lead.provider) ? io.lead : undefined,
    available: io.available.filter((model) => !isExhausted(model.provider)),
  });
  const processAlive = deps.processAlive ?? isProcessAlive;
  const pid = deps.pid ?? process.pid;

  /** Herdr presentation is never needed for correctness: fire and forget, swallow every error, a synchronous throw included. */
  const bestEffort = (call: () => Promise<unknown> | undefined) => void (async () => call())().catch(() => undefined);

  /** `[a-z][a-z0-9_-]{0,31}`, unique enough among live agents thanks to the id. */
  const agentName = (worker: Worker) =>
    `lead-${slugify(worker.title).slice(0, 22).replace(/-+$/, "")}-${worker.id.slice(0, 4)}`;

  /** Increasing across Lead restarts, so Herdr never keeps an older report over a newer one. */
  let metadataSeq = 0;
  const nextSeq = () => (metadataSeq = Math.max(metadataSeq + 1, now()));

  /**
   * Renames run one after another per worker, each with the label of the
   * state at that moment, so a late one never brings back an older glyph.
   * The label counts as shown only once Herdr took it.
   */
  const relabel = (worker: Worker) => {
    worker.renaming = (worker.renaming ?? Promise.resolve()).then(async () => {
      const workspaceId = worker.workspaceId;
      const label = tabLabel(worker);
      if (!workspaceId || label === worker.tabLabel) return;
      try {
        await deps.herdr?.renameWorktree(workspaceId, label);
        worker.tabLabel = label;
      } catch {
        // Retried on the next state change.
      }
    });
  };

  /** The tab closes right after these states: describing it again would only race the close. */
  const closing = (worker: Worker) =>
    (worker.state === "done" && worker.pr === undefined) || worker.state === "stopped" || (worker.state === "failed" && !deps.config.keepFailedWorkers);

  /** A done worker whose PR awaits merging: its tab stays open, so a conflict or red CI can go back to it. */
  const awaitsMerge = (worker: Worker) => worker.state === "done" && worker.pr !== undefined && worker.paneId !== undefined;

  /** Title, sidebar name, tokens and tab label of the worker's pane, reported on every state change. */
  const describe = (worker: Worker) => {
    const paneId = worker.paneId;
    if (!paneId || closing(worker)) return;
    relabel(worker);
    const labels = stateLabels(worker, worker.route);
    bestEffort(() =>
      deps.herdr?.reportMetadata(paneId, {
        title: plainTitle(worker.title),
        displayAgent: `pi-lead ${worker.kind}`,
        tokens: {
          model: worker.route.model,
          thinking: worker.route.thinking,
          ...(worker.branch ? { branch: worker.branch } : {}),
          worker: worker.id.slice(0, 8),
          state: worker.state,
        },
        workingLabel: labels.working,
        idleLabel: labels.idle,
        blockedLabel: labels.blocked,
        seq: nextSeq(),
      }),
    );
  };

  const setState = (worker: Worker, state: WorkerState) => {
    if (state === "running" && worker.state !== "running") worker.runningSince = now();
    worker.state = state;
    // Only a finish says why a worker waits; any other state starts from none.
    if (state !== "waiting" && state !== "done" && state !== "failed") worker.verdict = undefined;
    describe(worker);
    // A later Lead that adopts the worker picks up from this state.
    void writeRecord(worker);
    // A worker that stopped and needs the user may sit in a background tab: say so outside the Lead too.
    const notice = attentionNotice(worker);
    if (notice) bestEffort(() => deps.herdr?.notify(notice.title, notice.sound));
  };

  /** `agent rename` only works once Herdr has detected the Pi, so it gets one retry. */
  const nameAgent = (worker: Worker) => {
    const paneId = worker.paneId;
    if (!paneId || worker.named || worker.renameTries >= 2) return;
    worker.renameTries += 1;
    bestEffort(() =>
      deps.herdr?.renameAgent(paneId, agentName(worker)).then(() => {
        worker.named = true;
      }),
    );
  };

  const adoptable = (worker: Worker): AdoptableWorker | undefined =>
    worker.paneId && worker.repo ? (Object.fromEntries(ADOPTED.map((key) => [key, worker[key]])) as AdoptableWorker) : undefined;

  /**
   * Best-effort as well: without a record a crashed Lead's tab is only left
   * open, never wrongly closed. Writes run one after another per worker, each
   * with the worker as it is then, so a late one never brings back an older state.
   */
  const writeRecord = (worker: Worker) => {
    worker.recording = (worker.recording ?? Promise.resolve()).then(async () => {
      if (!worker.taskDir) return;
      const snapshot = adoptable(worker);
      const record: TabRecord = {
        version: 1,
        leadPid: pid,
        createdAt: worker.createdAt ?? new Date().toISOString(),
        ...(worker.workspaceId ? { workspaceId: worker.workspaceId } : {}),
        ...(worker.paneId ? { paneId: worker.paneId } : {}),
        ...(worker.state === "failed" ? { failed: true } : {}),
        ...(snapshot ? { worker: snapshot } : {}),
      };
      await replaceRecord(worker.taskDir, record).catch(() => undefined);
    });
    return worker.recording;
  };

  const readRecord = async (dir: string): Promise<TabRecord | undefined> => {
    try {
      const record = JSON.parse(await readFile(join(dir, RECORD), "utf8")) as TabRecord;
      // A pid of 0 or below would signal a process group.
      return Number.isInteger(record?.leadPid) && record.leadPid > 0 ? record : undefined;
    } catch {
      return undefined;
    }
  };

  const readIfPresent = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  /** Wait for a result newer than the last one seen, or for Pi to exit. */
  const waitForResult = async (worker: Worker): Promise<WorkerResult> => {
    let lastBeat = Date.now();
    while (true) {
      const raw = await readIfPresent(worker.resultPath!);
      let parsed: unknown;
      try {
        parsed = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        // Caught mid-write: read it again on the next poll.
      }
      if (parsed !== undefined) {
        const result = parseWorkerResult(parsed, worker.id);
        if (result.seq > worker.lastSeq) return result;
      }
      // run.sh records Pi's exit status; an empty file is `echo $? >` between truncate and write.
      const exit = (await readIfPresent(worker.exitPath!))?.trim();
      if (exit) throw new Error(`worker Pi exited (status ${exit}) without calling finish`);
      if (Date.now() - lastBeat >= heartbeatMs) {
        // By now Herdr has detected the Pi, if the name failed at tab creation.
        if (worker.state === "running") nameAgent(worker);
        // A pane that died before run.sh ran leaves no exit file and no result: catch it via Herdr's own workspace list.
        if (worker.workspaceId && deps.herdr) {
          const workspaces = await deps.herdr.listWorkspaces().catch(() => undefined);
          // A listing without the Lead's own workspace is not trustworthy (as in reconcile).
          if (workspaces?.includes(deps.herdr.workspace) && !workspaces.includes(worker.workspaceId)) {
            throw new Error("worker tab closed before Pi finished");
          }
        }
        lastBeat = Date.now();
      }
      await sleep(pollMs, undefined, { signal: worker.controller.signal });
    }
  };

  /**
   * Remove the worktree (which kills its Pi and deletes the checkout; the
   * branch is kept), then remove the task dir unless it is kept for
   * inspection.
   */
  const closeAndClean = async (worker: Worker, keepDir = false) => {
    // A rename still in flight must not land after the remove (bounded by Herdr's exec timeout).
    await worker.renaming;
    if (worker.workspaceId) await deps.herdr?.removeWorktree(worker.workspaceId).catch(() => undefined);
    worker.workspaceId = undefined;
    worker.paneId = undefined;
    if (!worker.taskDir) return;
    // A record write still in flight must not land in the directory while it is removed.
    await worker.recording;
    if (keepDir) await writeRecord(worker); // no worktree left to remove
    else await deps.workspace.remove(worker.taskDir).catch(() => undefined);
  };

  const launch = async (worker: Worker) => {
    const { params, io } = worker;
    worker.attempts += 1;
    worker.lastSeq = 0;
    worker.handledSeq = 0;
    worker.named = false;
    worker.renameTries = 0;
    worker.createdAt = new Date().toISOString();
    await mkdir(deps.stateRoot, { recursive: true });
    worker.taskDir = await mkdtemp(join(deps.stateRoot, `${worker.id.slice(0, 8)}-`));
    // Owned from the start, so a later Lead never mistakes it for an orphan while this one lives.
    await writeRecord(worker);
    worker.worktreePath = join(worker.taskDir, "worktree");
    worker.resultPath = join(worker.taskDir, "result.json");
    worker.exitPath = join(worker.taskDir, "exit");
    worker.repoRoot = await deps.workspace.repoRoot(io.cwd);
    worker.branch = `pi-lead/${slugify(params.title)}-${worker.id.slice(0, 6)}${worker.attempts > 1 ? `-${worker.attempts}` : ""}`;
    // A resumed attempt starts from the previous branch; its report still covers everything since the first base.
    worker.base ??= await deps.workspace.resolveBase({
      repoRoot: worker.repoRoot,
      ...(params.startFrom ? { startFrom: params.startFrom } : {}),
    });
    // Captured once, at the ticket's first launch: a reroute starts from the previous worker
    // branch, but the PR still targets the original one. Gated on `originBase`
    // (always set once resolved), not `baseBranch` (stays undefined on a detached HEAD).
    if (worker.originBase === undefined) {
      worker.baseBranch = params.startFrom ?? (await deps.workspace.currentBranch(worker.repoRoot));
      worker.originBase = worker.base;
    }
    // Set on the first launch of a publishing kind; a later reroute keeps
    // pushing onto this same remote branch instead of opening a second PR.
    if (PUBLISHED_KINDS.includes(worker.kind)) worker.remoteBranch ??= worker.branch;
    worker.tabLabel = tabLabel(worker);
    // Herdr's `worktree create` needs the main checkout: it rejects a linked worktree as its `cwd`.
    worker.repo = await deps.workspace.mainCheckout(worker.repoRoot);
    ({ workspaceId: worker.workspaceId, paneId: worker.paneId } = await deps.herdr!.createWorktree({
      cwd: worker.repo,
      branch: worker.branch,
      base: worker.base,
      path: worker.worktreePath,
      label: worker.tabLabel,
    }));
    await writeRecord(worker);
    const task: WorkerTask = {
      version: 1,
      id: worker.id,
      kind: worker.kind,
      title: params.title,
      task: params.task,
      branch: worker.branch,
      worktreePath: worker.worktreePath,
      resultPath: worker.resultPath,
      stuckDetection: deps.config.stuckDetection,
    };
    const taskPath = join(worker.taskDir, "task.json");
    await writeFile(taskPath, JSON.stringify(task, null, 2));
    const label = `lead: ${params.title}`.slice(0, 48);
    const publish =
      PUBLISHED_KINDS.includes(worker.kind) && worker.baseBranch !== undefined
        ? { baseBranch: worker.baseBranch, remoteBranch: worker.remoteBranch!, title: params.title }
        : undefined;
    const argv = deps.workerCommand({
      taskPath,
      prompt: workerPrompt(worker.kind, params.task, publish) + (worker.resumed ? RESUME_NOTE : ""),
      route: worker.route,
      label,
      projectTrusted: io.projectTrusted,
    });
    const script = join(worker.taskDir, "run.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        // The worker's tools run in its own git worktree: no isolation from the host.
        `cd ${shellQuote(worker.worktreePath!)} || exit 1`,
        // Author commits as the worker, without touching the repo's shared git config.
        "export GIT_AUTHOR_NAME='PI Lead worker' GIT_AUTHOR_EMAIL='pi-lead-worker@localhost'",
        "export GIT_COMMITTER_NAME='PI Lead worker' GIT_COMMITTER_EMAIL='pi-lead-worker@localhost'",
        // Lets Herdr recognise the Pi behind the node process as a Pi agent.
        "export HERDR_AGENT=pi",
        // The worker loads the user's extensions: this keeps an installed Lead extension inert in it.
        `export ${ROLE_ENV}=worker`,
        argv.map(shellQuote).join(" "),
        `echo $? > ${shellQuote(worker.exitPath)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    // The worktree's pane starts as an idle shell already cd'd there; type the run script into it.
    await deps.herdr!.runCommand(worker.paneId, `/bin/sh ${shellQuote(script)}`);
    describe(worker);
    nameAgent(worker);
    progress(`"${worker.title}" started on ${worker.route.model} (${worker.route.thinking})`);
  };

  const header = (worker: Worker) => [
    `Worker "${worker.title}" [${worker.id.slice(0, 8)}]: ${worker.route.model} · thinking ${worker.route.thinking} · tier ${worker.route.tier}` +
      (worker.difficulty !== undefined ? ` (Jev difficulty ${worker.difficulty.toFixed(1)}/4)` : " (default tier; Jev unavailable)"),
    ...(worker.route.note ? [`Note: ${worker.route.note}`] : []),
  ];

  const cardBase = (worker: Worker) => ({
    kind: worker.kind,
    title: worker.title,
    model: worker.route.model,
    thinking: worker.route.thinking,
    elapsedMs: Math.max(0, now() - (worker.runningSince ?? worker.delegatedAt)),
  });

  const settle = async (worker: Worker, result: WorkerResult) => {
    const claimsProgress = WRITES_CODE.includes(worker.kind) && (result.status === "done" || result.status === "partial");
    const collected = await deps.workspace.collect({
      repoRoot: worker.repoRoot!,
      branch: worker.branch!,
      base: worker.base!,
    });

    // The worker itself pushed, opened the PR and watched CI before calling finish; the host makes
    // one non-watching check of it. A detached HEAD (no baseBranch) means the worker was never asked to publish.
    let pr: Awaited<ReturnType<typeof deps.workspace.prChecks>> | undefined;
    if (result.status === "done" && PUBLISHED_KINDS.includes(worker.kind) && worker.baseBranch !== undefined) {
      pr = await deps.workspace.prChecks({ repoRoot: worker.repoRoot!, branch: worker.remoteBranch! });
      // Checks run on the PR's head: green on an older commit is not green on the branch.
      if (pr.url !== undefined && pr.state !== "error" && pr.head !== collected.head) pr = { ...pr, state: "pending", failed: [] };
    }
    // A PR is open and CI is green on its head (or the repository runs no checks): the host has
    // proven the work, and no model may downgrade it.
    const proven = pr?.url !== undefined && (pr.state === "pass" || pr.state === "none");
    const jevVerdict = proven
      ? undefined
      : await deps.judge.verdict({
          task: worker.params.task,
          reported: result.status,
          summary: result.summary,
          diffStat: collected.diffStat,
          commits: collected.commits,
          changedFiles: collected.changedFiles,
        });
    // Trust the more pessimistic of the worker and Jev.
    const judged =
      jevVerdict && VERDICT_ORDER.indexOf(jevVerdict) > VERDICT_ORDER.indexOf(result.status) ? jevVerdict : result.status;
    let status = judged;
    const sensitive = sensitivePatterns(collected.changedFiles);
    worker.changedFiles = collected.changedFiles;
    // Other workers' PRs still waiting to merge that change a file this branch changes: a likely conflict.
    const changed = new Set(collected.changedFiles);
    const sharedWith = [...workers.values()].flatMap((other) => {
      if (other === worker || other.state !== "done" || other.pr === undefined || other.retired) return [];
      const files = (other.changedFiles ?? []).filter((file) => changed.has(file));
      return files.length ? [{ title: other.title, pr: other.pr, files }] : [];
    });

    // Only a `done` report is capped by its PR and CI.
    let ci: string | undefined;
    if (status !== "done") pr = undefined;
    if (pr) {
      if (pr.state === "error") {
        status = "partial"; // gh could not be read: CI not checked
        ci = `not checked (${pr.error})`;
      } else if (!pr.url) {
        status = "partial"; // done reported, but no PR is open on that branch
        ci = "not checked (no PR)";
      } else if (pr.state === "pass") {
        ci = "passed";
      } else if (pr.state === "none") {
        ci = "none"; // the repository runs no checks for this branch
      } else {
        status = "partial"; // still failing or pending: cap the report
        ci = pr.state === "fail" ? `failed (${pr.failed.length} check${pr.failed.length === 1 ? "" : "s"})` : "pending";
      }
    } else if (claimsProgress) {
      // Code work the host checked nothing of: say so rather than stay silent.
      ci = PUBLISHED_KINDS.includes(worker.kind) && worker.baseBranch !== undefined ? "not checked (not done)" : "not checked (no PR)";
    }

    // Capped only by the host's own evidence (the worker and Jev said done): the worker gets that
    // evidence and fixes it itself, once, before the Lead hears about it.
    const ciRed = pr?.url !== undefined && (pr.state === "fail" || pr.state === "pending") ? pr : undefined;
    if (judged === "done" && status === "partial" && ciRed && !worker.sentBack) {
      const evidence =
        ciRed.state === "fail"
          ? [`CI is not green on ${ciRed.url}. Failed checks:`, ...checkList(ciRed.failed)]
          : ciRed.head === collected.head
            ? [`CI is not green on ${ciRed.url}: its checks are still pending.`]
            : [`CI is not green on ${ciRed.url}: the PR head is ${ciRed.head ?? "unknown"}, not your branch head ${collected.head}; push your branch.`];
      const unsent = await relay(
        worker,
        ["The host capped your finish to partial:", ...evidence, "Fix it, commit (push and wait for CI again if you published), then call `finish` again."].join("\n"),
      );
      if (unsent === undefined) {
        worker.sentBack = true;
        progress(`"${worker.title}": ${ciRed.state === "fail" ? "CI failed" : "CI pending"}; sent back to the worker`);
        return;
      }
    }

    const keep = status !== "done" && deps.config.keepFailedWorkers;
    worker.verdict = status;
    // Green and open: the tab stays until the PR is merged (or the Lead session ends).
    worker.pr = status === "done" && pr?.url ? pr.url : undefined;
    setState(worker, status === "done" ? "done" : keep ? "waiting" : "failed");
    if (!keep && worker.pr === undefined) await closeAndClean(worker);

    const id = worker.id.slice(0, 8);
    const next: string[] = [];
    if (keep) {
      next.push(`The worker waits in its tab: relay what it needs with \`worker\` (action message, id ${id}), or stop it.`);
    }
    if (status === "needs_human") next.push(keep ? "Ask the user for what the worker needs, then relay the answer." : "Ask the user for what the worker needed, then delegate a new task with the answer.");
    if (status === "partial" || status === "blocked") next.push("Tell the user what is left; continue only if they agree.");
    if (pr?.state === "error") next.push(`PI Lead could not read the PR or its checks (${pr.error}); tell the user.`);
    else if (pr && !pr.url) next.push(`The worker reported done but opened no PR on branch ${worker.remoteBranch}; tell the user.`);
    if (pr?.url && (pr.state === "fail" || pr.state === "pending")) next.push(`CI is not green on ${pr.url}; tell the user.`);
    if (status === "done" && worker.kind === "review" && result.findings) next.push("Review found issues: delegate an implement task with these findings, starting from the reviewed branch, without asking the user first.");
    if (status === "done" && worker.kind !== "review") {
      next.push(
        pr?.url
          ? `PR opened: ${pr.url}. The worker's tab stays open until it is merged: merge it with \`merge\` only once the user says so.`
          : `Work is on local branch ${worker.branch}; nothing was pushed or merged.`,
      );
    }
    const resume = keep
      ? "relay a message to the worker to continue, or stop it"
      : `delegate again, starting from branch ${worker.branch}`;
    if (result.quota) {
      const until = exhausted.get(providerOf(worker.route.model));
      next.push(
        `The quota of ${providerOf(worker.route.model)} is exhausted` + (until ? ` (back around ${clock(until)})` : "") +
          (result.uncommitted ? "; the worker has uncommitted changes, so it was not moved to another model" : " and no other configured model is available") +
          `; nothing was charged to a paid balance. Tell the user; once the quota is back, ${resume}.`,
      );
    } else if (result.modelError) {
      next.push(`The model stopped on a provider error: tell the user; to retry, ${resume}.`);
    }

    const section = (heading: string, body: string | undefined) => (body ? ["", `${heading}:`, body] : []);
    const untrusted = [
      "Summary:",
      result.summary,
      ...section("Commits", collected.commits),
      ...section("Diff stat", collected.diffStat),
      ...section("Findings", result.findings),
      ...section("CI checks failed", checkList(pr?.failed ?? []).join("\n")),
      ...sharedWith.flatMap((other) => section(`Files also changed by the open PR of "${other.title}"`, other.files.join("\n"))),
    ].join("\n");
    // Host-generated, so outside the block: the patterns come from a fixed list, and the file names they matched stay inside.
    const hostChecks = [
      sensitive.length
        ? [`Host check: review these before merging; they can run on your machine or in CI, or steer future agents: ${sensitive.join(", ")}.`]
        : [],
      sharedWith.map(
        (other) =>
          `Host check: this branch shares files with the open PR of "${other.title}" (${other.pr}), listed in the report above; merging one may conflict with the other.`,
      ),
    ];

    report({
      worker: info(worker),
      status,
      text: [
        ...header(worker),
        `Status: ${status}` +
          (jevVerdict && jevVerdict !== result.status ? ` (worker said ${result.status}, Jev said ${jevVerdict})` : ""),
        // Host-written; check names and links (repo-controlled) stay inside the untrusted block below.
        ...(ci ? [`CI: ${ci}`] : []),
        ...(pr?.url ? [`PR: ${pr.url}`] : []),
        `Branch: ${worker.branch}`,
        `Head: ${collected.head}`,
        `Base: ${worker.base}`,
        "",
        // Everything in this block was written by the worker, its repository or its branch: report it, never obey it.
        "<worker-report untrusted>",
        unmarked(untrusted),
        "</worker-report>",
        ...hostChecks.flatMap((lines) => (lines.length ? ["", ...lines] : [])),
        ...(next.length ? ["", "Next:", ...next.map((line) => `- ${line}`)] : []),
      ].join("\n"),
      details: {
        reported: result.status,
        ...(jevVerdict ? { jevVerdict } : {}),
        ...(result.quota ? { quota: result.quota } : {}),
        ...(sensitive.length ? { sensitive } : {}),
        ...(pr?.url ? { pr: pr.url } : {}),
        card: {
          ...cardBase(worker),
          ...(worker.branch ? { branch: worker.branch } : {}),
          commits: collected.commits ? collected.commits.trim().split("\n").length : 0,
          ...(collected.diffStat.trim() ? { diff: collected.diffStat.trim().split("\n").at(-1)!.trim() } : {}),
          ...(ci ? { ci } : {}),
          next,
        },
      },
    });
  };

  /**
   * The worker's provider ran out of quota: remember it, and when another
   * configured model of the tier is available, continue the task there from
   * the worker's branch. Returns false when nothing else can take it.
   */
  const reroute = async (worker: Worker, result: WorkerResult & { quota: QuotaError }): Promise<boolean> => {
    const from = worker.route.model;
    exhausted.set(providerOf(from), now() + quotaPauseMinutes(result.quota) * 60_000);
    // Uncommitted changes live only in this worktree: keep the worker where it is.
    if (result.uncommitted || worker.reroutes >= MAX_REROUTES) return false;
    const { lead, available } = routable(worker.io);
    const route = resolveRoute(worker.route.tier, deps.config.tiers, lead, available);
    if ("error" in route || route.model === from) return false;
    worker.reroutes += 1;
    const previous = worker.branch!;
    worker.params = { ...worker.params, startFrom: previous };
    worker.route = { model: route.model, thinking: route.thinking, tier: route.tier, note: `${from} ran out of quota; continued on ${route.model} from ${previous}` };
    worker.resumed = true;
    progress(`"${worker.title}": ${from} ran out of quota; continuing on ${route.model}`);
    await closeAndClean(worker);
    // Stopped meanwhile: open no new tab.
    if (worker.controller.signal.aborted) throw worker.controller.signal.reason;
    // Not setState: its tab is gone. A worker left waiting (the user may have typed in its tab) no longer waits on the user.
    worker.state = "starting";
    worker.verdict = undefined;
    await launch(worker);
    setState(worker, "running");
    return true;
  };

  const fail = async (worker: Worker, error: unknown) => {
    // Closed on purpose, and already said so.
    if (worker.retired) return;
    // A done worker's tab closed or its Pi exited while its PR awaited merging: the work stands, and
    // `merge` still takes the PR (a problem then goes to the user).
    if (worker.state === "done") {
      await closeAndClean(worker);
      return;
    }
    if (worker.controller.signal.aborted) {
      setState(worker, "stopped");
      await closeAndClean(worker);
      report({
        worker: info(worker),
        status: "stopped",
        text: `Worker "${worker.title}" [${worker.id.slice(0, 8)}] was stopped.`,
        details: {},
      });
      return;
    }
    const keep = deps.config.keepFailedWorkers;
    worker.verdict = undefined;
    setState(worker, "failed");
    // A kept tab is for inspection only: it is closed when the Lead session ends.
    if (keep) await writeRecord(worker);
    else await closeAndClean(worker);
    report({
      worker: info(worker),
      status: "failed",
      text: [
        ...header(worker),
        `Worker failed: ${errorText(error)}`,
        ...(keep && worker.taskDir
          ? [`Kept for inspection: ${worker.taskDir} (its tab closes when this Lead session ends; the directory stays).`]
          : []),
      ].join("\n"),
      details: {
        card: {
          ...cardBase(worker),
          commits: 0,
          summary: errorText(error),
          next: keep && worker.taskDir ? [`Kept for inspection: ${worker.taskDir}`] : [],
        },
      },
    });
  };

  /**
   * Report every result until the worker ends. A worker left waiting on a
   * question is still watched: whether the Lead relays an answer or the user
   * types in its tab, its next `finish` is reported.
   */
  const watch = async (worker: Worker) => {
    try {
      do {
        const result = await waitForResult(worker);
        worker.lastSeq = result.seq;
        if (result.quota && (await reroute(worker, { ...result, quota: result.quota }))) continue;
        await settle(worker, result);
        // Only now: a Lead that dies mid-settle leaves this finish for the one that adopts the worker.
        worker.handledSeq = result.seq;
        void writeRecord(worker);
      } while (worker.state === "waiting" || worker.state === "running" || awaitsMerge(worker));
    } catch (error) {
      await fail(worker, error);
    } finally {
      worker.resolveDone();
    }
  };

  /** Background life of one worker: launch (one retry on failure), first result. */
  const drive = async (worker: Worker) => {
    try {
      while (true) {
        try {
          await launch(worker);
          setState(worker, "running");
          break;
        } catch (error) {
          if (worker.controller.signal.aborted || worker.attempts > 1) throw error;
          progress(`"${worker.title}" failed to start; retrying once`);
          await closeAndClean(worker);
          worker.base = undefined; // the retry is a fresh start: HEAD may have moved
        }
      }
    } catch (error) {
      await fail(worker, error);
      worker.resolveDone();
      return;
    }
    await watch(worker);
  };

  /**
   * Type a `[PI Lead]` message into a running or finished worker's Pi and mark
   * it running again: its next `finish` is watched as usual. Returns why it
   * could not, or undefined once sent.
   */
  async function relay(worker: Worker, text: string): Promise<string | undefined> {
    if (!worker.paneId || (worker.state !== "running" && worker.state !== "waiting" && !awaitsMerge(worker))) {
      return `Worker "${worker.title}" is ${worker.state}; it cannot receive messages.`;
    }
    if ((await readIfPresent(worker.exitPath!))?.trim()) return `Worker "${worker.title}" has exited; it cannot receive messages.`;
    try {
      await deps.herdr!.sendToAgent(worker.paneId, `[PI Lead] ${text}`);
    } catch (error) {
      return `Could not reach "${worker.title}" through Herdr: ${errorText(error)}`;
    }
    setState(worker, "running");
    return undefined;
  }

  /** Close a done worker's tab: its watcher ends quietly. */
  const retire = async (worker: Worker) => {
    worker.retired = true;
    worker.controller.abort(new Error("worker retired"));
    await closeAndClean(worker);
  };

  /** Merges run one after another, across `merge` calls too. */
  let merging: Promise<void> = Promise.resolve();
  const graceMs = deps.checksGraceMs ?? 15_000;

  const runMerges = async (targets: Array<MergeTarget & { worker?: Worker }>, method: MergeMethod | undefined) => {
    const merged: string[] = [];
    let stopped: { target: MergeTarget; text: string } | undefined;
    let index = 0;
    for (; index < targets.length; index += 1) {
      const target = targets[index]!;
      const worker = target.worker;
      // Sent back by an earlier run, or stopped since: not green any more.
      if (worker && worker.state !== "done") {
        stopped = { target, text: `Worker "${worker.title}" is ${worker.state}; merge its PR once it reports done again.` };
        break;
      }
      let step;
      try {
        step = await mergeOne(target, { workspace: deps.workspace, ...(method ? { method } : {}), graceMs, sleep: (ms) => sleep(ms) });
      } catch (error) {
        step = { merged: false as const, text: `Merging ${target.ref} failed: ${errorText(error)}`, sentBack: false };
      }
      if (!step.merged) {
        stopped = { target, text: step.text };
        break;
      }
      merged.push(`${target.ref} (${step.url})`);
      if (worker) await retire(worker);
      progress(`merged ${step.url}${worker ? `; closed the workspace of "${worker.title}"` : ""}`);
    }
    const rest = targets.slice(index + 1).map((target) => target.ref);
    const text = [
      merged.length ? `Merged, in order: ${merged.join(", ")}.` : "Merged nothing.",
      ...(stopped ? [`Stopped at ${stopped.target.ref}: ${unmarked(stopped.text)}`] : []),
      ...(rest.length
        ? [`Not attempted: ${rest.join(", ")}. Call \`merge\` with them again (after ${stopped!.target.ref}, if it still should go first) once it is fixed, as far as the user's go-ahead covers them.`]
        : []),
    ].join("\n");
    try {
      deps.onMergeReport?.(text);
    } catch {
      // A closed Lead session can throw on delivery.
    }
  };

  const find = (ref: string): Worker | { error: string } => {
    const needle = ref.trim().toLowerCase();
    const matches = [...workers.values()].filter(
      (w) => w.id.startsWith(needle) || w.title.toLowerCase() === needle || w.branch?.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0]!;
    return { error: matches.length ? `"${ref}" matches several workers; use its id` : `No worker "${ref}".` };
  };

  /** A dead Lead's worker whose Pi still runs: run.sh has not recorded its exit, and Herdr still sees the agent. */
  const piRuns = async (dir: string, record: TabRecord) => {
    if (!record.paneId || record.failed || !record.worker || !ADOPTABLE.includes(record.worker.state)) return false;
    if ((await readIfPresent(join(dir, "exit")).catch(() => "unreadable"))?.trim()) return false;
    return (await deps.herdr?.hasAgent(record.paneId).catch(() => false)) ?? false;
  };

  /** One claim per dead owner: only one of the Leads starting at once adopts its worker. */
  const claim = (dir: string, deadPid: number) =>
    writeFile(join(dir, `adopted-from-${deadPid}`), String(pid), { flag: "wx" }).then(
      () => true,
      () => false,
    );

  /** Rebuild the worker from its record and watch it like any other; the record then names this Lead. */
  const adopt = (dir: string, record: TabRecord, live: AdoptableWorker, io: DelegateIO) => {
    if (workers.has(live.id)) return;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const worker: Worker = {
      ...live,
      lastSeq: live.handledSeq,
      // A worker whose Lead died mid-launch already runs its Pi.
      state: live.state === "starting" ? "running" : live.state,
      io,
      controller: new AbortController(),
      done,
      resolveDone,
      taskDir: dir,
      worktreePath: join(dir, "worktree"),
      resultPath: join(dir, "result.json"),
      exitPath: join(dir, "exit"),
      workspaceId: record.workspaceId,
      paneId: record.paneId,
      createdAt: record.createdAt,
      // The earlier Lead named it already.
      named: true,
      renameTries: 0,
    };
    workers.set(worker.id, worker);
    void writeRecord(worker);
    describe(worker);
    progress(`adopted "${worker.title}" from an earlier Lead (${worker.state})`);
    void watch(worker).catch(() => undefined);
  };

  return {
    list: (): WorkerInfo[] => [...workers.values()].map(info),

    async start(params: DelegateParams, io: DelegateIO): Promise<StartResult> {
      if (!deps.herdr) {
        return { status: "failed", text: "PI Lead workers need Herdr: start this Pi session inside a Herdr pane, then delegate again." };
      }
      if (params.startFrom !== undefined && !isSafeBranchName(params.startFrom)) {
        return { status: "failed", text: `"${params.startFrom}" is not a valid local branch name.` };
      }
      const judged = await deps.judge.modelTier({ task: params.task, kind: params.kind });
      const tier: Tier = judged?.tier ?? DEFAULT_TIER;
      const { lead, available } = routable(io);
      const resolved = resolveRoute(tier, deps.config.tiers, lead, available);
      const skipped = exhaustedNote();
      if ("error" in resolved) return { status: "failed", text: `No worker model: ${resolved.error}${skipped ? ` (${skipped})` : ""}.` };
      const route = skipped && resolved.note ? { ...resolved, note: `${resolved.note} (${skipped})` } : resolved;

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => (resolveDone = resolve));
      const worker: Worker = {
        id: randomUUID(),
        title: params.title,
        kind: params.kind,
        state: "starting",
        route,
        params,
        io,
        difficulty: judged?.difficulty,
        controller: new AbortController(),
        done,
        resolveDone,
        lastSeq: 0,
        handledSeq: 0,
        attempts: 0,
        delegatedAt: now(),
        named: false,
        renameTries: 0,
        resumed: false,
        reroutes: 0,
        sentBack: false,
      };
      workers.set(worker.id, worker);
      void drive(worker).catch(() => undefined);
      return {
        status: "started",
        worker: info(worker),
        text: [
          `Delegated "${params.title}" [${worker.id.slice(0, 8)}] to ${route.model} (thinking ${route.thinking}, tier ${route.tier}` +
            (judged ? `, Jev difficulty ${judged.difficulty.toFixed(1)}/4).` : ", default tier)."),
          "It is starting in a background Herdr tab.",
          "Its result will arrive as a message; keep helping the user meanwhile.",
        ].join("\n"),
      };
    },

    /** Relay text to a worker: steer a running one, or resume one waiting on a question. */
    async message(ref: string, text: string): Promise<string> {
      const worker = find(ref);
      if ("error" in worker) return worker.error;
      return (await relay(worker, text)) ?? `Sent to "${worker.title}". Its next result will arrive as a message.`;
    },

    /**
     * Queue PRs to merge in the given order, after any queued before: each is
     * updated from its base, waits for green CI on its new head, and is merged
     * before the next one starts. A conflict or red CI goes back to the PR's
     * worker (or is reported) and stops the run. Returns at once; the run ends
     * with `onMergeReport`.
     */
    async merge(refs: readonly string[], io: DelegateIO, method?: MergeMethod): Promise<string> {
      if (refs.length === 0) return "Give the PRs to merge, in order.";
      const targets: Array<MergeTarget & { worker?: Worker }> = [];
      for (const ref of refs) {
        const needle = ref.trim();
        // A PR number or URL names that PR, and its worker when one here opened it.
        const prRef = /^\d{1,7}$/.test(needle) || /^https:\/\/\S+\/pull\/\d+$/.test(needle);
        const owner = prRef ? [...workers.values()].find((w) => w.pr === needle || w.pr?.endsWith(`/pull/${needle}`)) : undefined;
        const worker = owner ?? (prRef ? { error: "No worker" } : find(needle));
        if (!("error" in worker)) {
          if (!worker.pr || worker.state !== "done") {
            return `Worker "${worker.title}" is ${worker.state}${worker.pr ? "" : " with no open PR"}: only a done worker's green PR can be merged.`;
          }
          targets.push({
            ref: needle,
            pr: worker.pr,
            repoRoot: worker.repoRoot!,
            ...(worker.remoteBranch ? { branch: worker.remoteBranch } : {}),
            worker,
            sendBack: (text) => relay(worker, text),
          });
        } else if (prRef) {
          // A PR without a worker here (another session's, or its worker is gone): the user hears of any problem.
          targets.push({ ref: needle, pr: needle, repoRoot: await deps.workspace.repoRoot(io.cwd) });
        } else {
          return worker.error.startsWith("No worker") ? `No worker or PR "${ref}": give a worker id, title or branch, or a PR number or URL.` : worker.error;
        }
      }
      const run = merging.then(() => runMerges(targets, method));
      merging = run.catch(() => undefined);
      const names = targets.map((target) => target.ref).join(", ");
      return `Queued to merge, one at a time: ${names}. Each is updated from its base and merged once CI is green on its new head; the outcome arrives as a message.`;
    },

    async stop(ref: string): Promise<string> {
      const worker = find(ref);
      if ("error" in worker) return worker.error;
      if (awaitsMerge(worker)) {
        await retire(worker);
        return `Worker "${worker.title}" is done; its tab is closed.`;
      }
      if (worker.state === "done" || worker.state === "failed" || worker.state === "stopped") {
        if (worker.workspaceId) await closeAndClean(worker);
        return `Worker "${worker.title}" is already ${worker.state}; its tab is closed.`;
      }
      // The watcher sees the abort, removes the worktree and reports.
      worker.controller.abort(new Error("stopped by the Lead"));
      return `Stopping "${worker.title}".`;
    },

    /**
     * The Lead session ends: stop every worker that has not ended (waiting ones
     * included) and wait for their cleanup, then close every tab still open.
     * Only the Lead's own pane outlives it; a failed worker keeps its directory
     * (keepFailedWorkers) but never its tab.
     */
    async shutdown(): Promise<void> {
      const live = [...workers.values()].filter((worker) => !["done", "failed", "stopped"].includes(worker.state));
      for (const worker of live) worker.controller.abort(new Error("Lead session closed"));
      // Done workers whose PR was not merged: their watchers end quietly, and their tabs close below.
      for (const worker of workers.values()) {
        if (!awaitsMerge(worker)) continue;
        worker.retired = true;
        worker.controller.abort(new Error("Lead session closed"));
        live.push(worker);
      }
      await Promise.race([Promise.all(live.map((worker) => worker.done)), sleep(10_000)]);
      await Promise.all(
        [...workers.values()]
          .filter((worker) => worker.workspaceId)
          .map((worker) => closeAndClean(worker, worker.state === "failed" && deps.config.keepFailedWorkers)),
      );
    },

    /**
     * On Lead start, for the task records of earlier Lead processes now dead
     * (crash, kill): a worker of this Lead's repository (`io`) whose pane still
     * runs its Pi is adopted, watched from then on exactly like one this Lead
     * started; a live Pi of another repository is left for a Lead of that
     * repository; every other worktree is removed with its task dir (the
     * branch is kept). Records of live Leads (other sessions, or this
     * process) are left alone. Returns how many worktrees were removed.
     */
    async reconcile(io?: DelegateIO): Promise<number> {
      let names: string[];
      try {
        names = await readdir(deps.stateRoot);
      } catch {
        return 0;
      }
      const orphans: Array<{ dir: string; record: TabRecord }> = [];
      for (const name of names) {
        const dir = join(deps.stateRoot, name);
        const record = await readRecord(dir);
        if (record && record.leadPid !== pid && !processAlive(record.leadPid)) orphans.push({ dir, record });
      }
      const herdr = deps.herdr;
      // Nothing can be removed outside Herdr: keep the records for a Lead inside it.
      if (!herdr || orphans.length === 0) return 0;
      const workspaces = await herdr.listWorkspaces().catch(() => undefined);
      // If Herdr does not answer, or not even for the Lead's own workspace, try again on the next start.
      if (!workspaces || !workspaces.includes(herdr.workspace)) return 0;
      const repo = io
        ? await deps.workspace.repoRoot(io.cwd).then((root) => deps.workspace.mainCheckout(root)).catch(() => undefined)
        : undefined;
      let closed = 0;
      for (const { dir, record } of orphans) {
        const live = record.worker;
        if (io && live && record.workspaceId && workspaces.includes(record.workspaceId) && (await piRuns(dir, record))) {
          // Another repository's worker: its own Lead may still adopt it.
          if (live.repo !== repo) continue;
          // Lost the claim: another Lead started at the same moment and adopts it.
          if (await claim(dir, record.leadPid)) adopt(dir, record, live, io);
          continue;
        }
        if (record.workspaceId && workspaces.includes(record.workspaceId)) {
          try {
            await herdr.removeWorktree(record.workspaceId);
            closed += 1;
          } catch {
            continue; // keep the record: the worktree may still be running
          }
        }
        if (record.failed && deps.config.keepFailedWorkers) {
          const { workspaceId: _workspace, paneId: _pane, ...kept } = record;
          await replaceRecord(dir, kept).catch(() => undefined);
        } else {
          await deps.workspace.remove(dir).catch(() => undefined);
        }
      }
      if (closed) progress(`removed ${closed} worker worktree${closed === 1 ? "" : "s"} left by an earlier Lead`);
      return closed;
    },
  };
}

export type Delegator = ReturnType<typeof createDelegator>;
