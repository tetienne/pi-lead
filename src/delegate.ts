import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig, Tier } from "./config.ts";
import { isUsageError, type Herdr } from "./herdr.ts";
import { resolveRoute, type ModelRef, type RouteTier, type WorkerRoute } from "./model-routing.ts";
import { parseWorkerResult, PUBLISHED_KINDS, REVIEWED_KINDS, type WorkerResult, type WorkerTask, type WorkKind, type WorkerVerdict, workerPrompt } from "./protocol.ts";
import { providerOf, quotaPauseMinutes, type QuotaError } from "./quota.ts";
import { filesMatching, PACKAGE_JSON, packageRunFieldsChanged, sensitivePatterns } from "./sensitive-paths.ts";
import { attentionNotice, plainTitle, stateLabels, tabLabel } from "./worker-display.ts";
import type { Workspace } from "./workspace.ts";

export type DelegateParams = {
  kind: WorkKind;
  title: string;
  task: string;
  /** Local branch to start from (reviews start from the branch under review). */
  startFrom?: string;
  /** Model tier: fast for mechanical or single-module changes, deep for cross-cutting, subtle or debugging work, standard otherwise. Default standard. */
  tier?: Tier;
};

/** What the Lead's session knows when a task is delegated. */
export type DelegateIO = {
  cwd: string;
  lead: ModelRef | undefined;
  available: readonly ModelRef[];
  /** Whether the Lead trusts this project; workers then get its skills and prompts too. */
  projectTrusted: boolean;
};

export type WorkerState =
  | "queued"
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
};

export type DelegateOutcome = {
  worker: WorkerInfo;
  status: WorkerVerdict | "failed" | "stopped";
  /** Delivered to the Lead model as a message. */
  text: string;
  details: {
    reported?: WorkerVerdict;
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
 * worker wrote: the card always shows part of it, labelled untrusted.
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
  /** CI status of the draft PR (`none`, `passed`, `failed (N checks)`, `timed out`, `not checked (…)`). */
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

export type StartResult = { status: "started"; worker: WorkerInfo; text: string } | { status: "failed"; text: string };

export type WorkerCommand = (input: {
  taskPath: string;
  prompt: string;
  route: WorkerRoute;
  label: string;
  /** Whether the Lead trusts the project: the worker then loads its project Pi resources too. */
  projectTrusted: boolean;
}) => string[];

export type DelegateDeps = {
  config: LeadConfig;
  herdr: Herdr | undefined;
  workspace: Workspace;
  workerCommand: WorkerCommand;
  stateRoot: string;
  /** Called for every result: first finish, each later finish, failures and stops. */
  onOutcome(outcome: DelegateOutcome): void;
  /** Short progress lines, one per event (started, rerouted), for the Lead's transcript. */
  onProgress?(text: string): void;
  pollMs?: number;
  heartbeatMs?: number;
  /** Whether the Lead process that wrote a task record still runs (tests fake it). */
  processAlive?(pid: number): boolean;
  now?(): number;
};

/**
 * `tab.json` in each task dir, written by the Lead that owns it. A later Lead
 * uses it to remove the worktrees of a Lead that crashed or was killed.
 */
type TabRecord = {
  version: 1;
  leadPid: number;
  createdAt: string;
  workspaceId?: string;
  paneId?: string;
  /** A failed worker whose task dir is kept for inspection (keepFailedWorkers). */
  failed?: boolean;
};

const RECORD = "tab.json";

/** Model changes a single task may go through on quota errors. */
const MAX_REROUTES = 3;

const RESUME_NOTE =
  "\n\nA previous PI Lead worker ran out of model quota on this task. Its work so far is committed on the current branch: review it with git log and continue from there.";

/** Abort reason of a worker that waited too long on a question. */
class WaitingTimeout extends Error {}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Worker = WorkerInfo & {
  params: DelegateParams;
  io: DelegateIO;
  /** Set once at first launch: the remote branch to push to, reused across a reroute too. */
  remoteBranch?: string;
  controller: AbortController;
  done: Promise<void>;
  resolveDone(): void;
  taskDir?: string;
  worktreePath?: string;
  repoRoot?: string;
  base?: string;
  /**
   * The ticket's original base commit, set once at first launch. Gated so a
   * reroute (whose `startFrom` is the previous attempt's branch) never
   * recaptures `baseBranch` as one of PI Lead's own `pi-lead/...` branches.
   */
  originBase?: string;
  /** The branch the checkout was on when the ticket was first delegated; the PR base. Undefined on a detached HEAD. */
  baseBranch?: string;
  workspaceId?: string;
  paneId?: string;
  resultPath?: string;
  exitPath?: string;
  lastSeq: number;
  attempts: number;
  createdAt?: string;
  /** When the task was delegated, and when the worker last started running (a relayed answer, a reroute): the card times this run. */
  delegatedAt: number;
  runningSince?: number;
  /** When the worker started waiting on a question (waitingTimeoutMinutes). */
  waitingSince?: number;
  /** The label Herdr last took for the worktree workspace, so a state change renames it only when it changes. */
  tabLabel?: string;
  /** The worker's pending worktree renames, in order. */
  renaming?: Promise<void>;
  /** Herdr agent name: set once, tried at most twice per tab. */
  named: boolean;
  renameTries: number;
  /** Continues the branch of an attempt that ran out of quota. */
  resumed: boolean;
  reroutes: number;
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
export const INVISIBLE = /(?<!\p{Extended_Pictographic})[︎️]|(?![︎️])\p{Default_Ignorable_Code_Point}|؜/gu;

/**
 * Worker text as the report carries it, for the model and the card alike:
 * without invisible characters, and never opening or closing the report's
 * untrusted block, look-alikes of the marker included.
 */
export function unmarked(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[<＜﹤]\s*(\/?)\s*(worker[\s_‐-―-]{0,3}report)/giu, "‹$1$2");
}

export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes("..") && !name.endsWith("/") &&
    !name.endsWith(".lock") && !name.includes("//");
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Delegation is asynchronous: `start` returns as soon as the worker is queued,
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
  });

  const waitingTimeoutMs = deps.config.waitingTimeoutMinutes * 60_000;
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

  /** Herdr presentation is never needed for correctness: fire and forget, swallow every error. */
  const bestEffort = (call: () => Promise<unknown> | undefined) => {
    try {
      void call()?.catch(() => undefined);
    } catch {
      // A synchronous throw is swallowed too.
    }
  };

  /** `[a-z][a-z0-9_-]{0,31}`, unique enough among live agents thanks to the id. */
  const agentName = (worker: Worker) =>
    `lead-${slugify(worker.title).slice(0, 22).replace(/-+$/, "")}-${worker.id.slice(0, 4)}`;

  /** Increasing across Lead restarts, so Herdr never keeps an older report over a newer one. */
  let metadataSeq = 0;
  const nextSeq = () => (metadataSeq = Math.max(metadataSeq + 1, now()));

  /** Cleared once Herdr rejects `tab rename` as unknown (an older Herdr): later tabs open without a state glyph. */
  let tabRenames = true;
  const openingLabel = (worker: Worker) => (tabRenames ? tabLabel(worker) : plainTitle(worker.title));

  /**
   * Renames run one after another per worker, each with the label of the
   * state at that moment, so a late one never brings back an older glyph.
   * The label counts as shown only once Herdr took it.
   */
  const relabel = (worker: Worker) => {
    worker.renaming = (worker.renaming ?? Promise.resolve()).then(async () => {
      const workspaceId = worker.workspaceId;
      const label = tabLabel(worker);
      if (!tabRenames || !workspaceId || label === worker.tabLabel) return;
      try {
        await deps.herdr?.renameWorktree(workspaceId, label);
        worker.tabLabel = label;
      } catch (error) {
        // Only a Herdr without `workspace rename` switches glyphs off; anything else is retried on the next state change.
        if (isUsageError(error)) tabRenames = false;
      }
    });
  };

  /** The tab closes right after these states: describing it again would only race the close. */
  const closing = (worker: Worker) =>
    worker.state === "done" || worker.state === "stopped" || (worker.state === "failed" && !deps.config.keepFailedWorkers);

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

  /** Best-effort as well: without a record a crashed Lead's tab is only left open, never wrongly closed. */
  const writeRecord = async (worker: Worker) => {
    if (!worker.taskDir) return;
    const record: TabRecord = {
      version: 1,
      leadPid: process.pid,
      createdAt: worker.createdAt ?? new Date().toISOString(),
      ...(worker.workspaceId ? { workspaceId: worker.workspaceId } : {}),
      ...(worker.paneId ? { paneId: worker.paneId } : {}),
      ...(worker.state === "failed" ? { failed: true } : {}),
    };
    await writeFile(join(worker.taskDir, RECORD), JSON.stringify(record, null, 2)).catch(() => undefined);
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
      // An unanswered question must not keep a worker running forever: the abort ends in `fail`.
      if (worker.state === "waiting" && waitingTimeoutMs > 0 && Date.now() - (worker.waitingSince ?? 0) >= waitingTimeoutMs) {
        worker.controller.abort(new WaitingTimeout(`no answer within ${deps.config.waitingTimeoutMinutes} minutes`));
      }
      await sleep(pollMs, worker.controller.signal);
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
    if (keepDir) await writeRecord(worker); // no worktree left to remove
    else await deps.workspace.remove(worker.taskDir).catch(() => undefined);
  };

  const launch = async (worker: Worker) => {
    const { params, io } = worker;
    worker.attempts += 1;
    worker.lastSeq = 0;
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
    // A reroute starts the worktree from the previous attempt's branch tip; `worker.base`
    // stays the ticket's first base, so the report still covers everything since then.
    const startAt = await deps.workspace.resolveBase({
      repoRoot: worker.repoRoot,
      ...(params.startFrom ? { startFrom: params.startFrom } : {}),
    });
    worker.base ??= startAt;
    // Captured once, at the ticket's first launch: a reroute sets `startFrom` to one of
    // PI Lead's own `pi-lead/...` branches, which must never become the PR base. Gated on
    // `originBase` (always set once resolved), not `baseBranch` (stays undefined on a detached HEAD).
    if (worker.originBase === undefined) {
      worker.baseBranch = params.startFrom ?? (await deps.workspace.currentBranch(worker.repoRoot));
      worker.originBase = worker.base;
    }
    // Set on the first launch of a publishing kind; a later reroute keeps
    // pushing onto this same remote branch instead of opening a second PR.
    if (PUBLISHED_KINDS.includes(worker.kind)) worker.remoteBranch ??= worker.branch;
    worker.tabLabel = openingLabel(worker);
    ({ workspaceId: worker.workspaceId, paneId: worker.paneId } = await deps.herdr!.createWorktree({
      // Herdr's `worktree create` needs the main checkout: it rejects a linked worktree as its `cwd`.
      cwd: await deps.workspace.mainCheckout(worker.repoRoot),
      branch: worker.branch,
      base: startAt,
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
      ...(REVIEWED_KINDS.includes(worker.kind) ? { base: worker.originBase!, review: reviewRoute(worker) } : {}),
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

  /** Resolved at each launch, so a relaunch after a quota error skips the exhausted provider. */
  const reviewRoute = (worker: Worker) => {
    const { lead, available } = routable(worker.io);
    const route = resolveRoute("review", deps.config.tiers, lead, available);
    const review = "error" in route ? { model: worker.route.model, thinking: worker.route.thinking } : { model: route.model, thinking: route.thinking };
    const notes = ["error" in route ? route.error : route.note].filter(Boolean);
    if (review.model === worker.route.model) notes.push(`review runs on ${review.model}, same as the worker: set tiers.review for an independent model`);
    if (notes.length) progress(`"${worker.title}": ${notes.join("; ")}`);
    return review;
  };

  const header = (worker: Worker) => [
    `Worker "${worker.title}" [${worker.id.slice(0, 8)}]: ${worker.route.model} · thinking ${worker.route.thinking} · tier ${worker.route.tier}`,
    ...(worker.route.note ? [`Note: ${worker.route.note}`] : []),
  ];

  /** Sensitive patterns the branch touches, keeping `package.json` only when some file's scripts or package manager changed. */
  const reviewHints = async (worker: Worker, changedFiles: string[]): Promise<string[]> => {
    const patterns = sensitivePatterns(changedFiles);
    if (!patterns.includes(PACKAGE_JSON)) return patterns;
    const read = (rev: string, path: string) => deps.workspace.fileAt({ repoRoot: worker.repoRoot!, rev, path });
    for (const path of filesMatching(PACKAGE_JSON, changedFiles)) {
      if (packageRunFieldsChanged(await read(worker.base!, path), await read(worker.branch!, path))) return patterns;
    }
    return patterns.filter((pattern) => pattern !== PACKAGE_JSON);
  };

  const cardBase = (worker: Worker) => ({
    kind: worker.kind,
    title: worker.title,
    model: worker.route.model,
    thinking: worker.route.thinking,
    elapsedMs: Math.max(0, now() - (worker.runningSince ?? worker.delegatedAt)),
  });

  const settle = async (worker: Worker, result: WorkerResult) => {
    const collected = await deps.workspace.collect({
      repoRoot: worker.repoRoot!,
      branch: worker.branch!,
      base: worker.base!,
    });
    let status: WorkerVerdict = result.status;
    const sensitive = await reviewHints(worker, collected.changedFiles);

    // The worker itself pushed, opened the PR and watched CI before calling finish; the host makes
    // one non-watching check of it. A detached HEAD (no baseBranch) means the worker was never asked to publish.
    let pr: Awaited<ReturnType<typeof deps.workspace.prChecks>> | undefined;
    let ci: string | undefined;
    if (status === "done" && PUBLISHED_KINDS.includes(worker.kind) && worker.baseBranch !== undefined) {
      pr = await deps.workspace.prChecks({ repoRoot: worker.repoRoot!, branch: worker.remoteBranch! });
      if (pr.state === "error") {
        status = "partial"; // gh could not be read: CI unverified
        ci = `not checked (${pr.error})`;
      } else if (!pr.url) {
        status = "partial"; // done reported, but no PR is open on that branch
      } else if (pr.state === "pass") {
        ci = "passed";
      } else if (pr.state === "none") {
        ci = "none"; // the repository runs no checks for this branch
      } else {
        status = "partial"; // still failing or pending: cap the report
        ci = pr.state === "fail" ? `failed (${pr.failed.length} check${pr.failed.length === 1 ? "" : "s"})` : "pending";
      }
    }

    const keep = status !== "done" && deps.config.keepFailedWorkers;
    worker.verdict = status;
    setState(worker, status === "done" ? "done" : keep ? "waiting" : "failed");
    if (keep) worker.waitingSince = Date.now();
    else await closeAndClean(worker);

    const id = worker.id.slice(0, 8);
    const next: string[] = [];
    if (keep) {
      next.push(
        `The worker waits in its tab: relay what it needs with \`worker\` (action message, id ${id}), or stop it.` +
          (waitingTimeoutMs > 0 ? ` Without an answer it is stopped after ${deps.config.waitingTimeoutMinutes} minutes.` : ""),
      );
    }
    if (status === "needs_human") next.push(keep ? "Ask the user for what the worker needs, then relay the answer." : "Ask the user for what the worker needed, then delegate a new task with the answer.");
    if (status === "partial" || status === "blocked") next.push("Tell the user what is left; continue only if they agree.");
    if (pr?.state === "error") next.push(`PI Lead could not read the PR or its checks (${pr.error}); tell the user.`);
    else if (pr && !pr.url) next.push(`The worker reported done but opened no PR on branch ${worker.remoteBranch}; tell the user.`);
    if (pr?.url && (pr.state === "fail" || pr.state === "pending")) next.push(`CI is not green on ${pr.url}; tell the user.`);
    if (status === "done" && worker.kind === "review" && result.findings) next.push("Review found issues: delegate an implement task with these findings, starting from the reviewed branch, without asking the user first.");
    if (status === "done" && worker.kind !== "review") {
      next.push(pr?.url ? `PR opened: ${pr.url}.` : `Work is on local branch ${worker.branch}; nothing was pushed or merged.`);
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

    report({
      worker: info(worker),
      status,
      text: [
        ...header(worker),
        `Status: ${status}` + (status !== result.status ? ` (worker said ${result.status})` : ""),
        // Host-written; check names and links (repo-controlled) stay inside the untrusted block below.
        ...(ci ? [`CI: ${ci}`] : []),
        ...(pr?.url ? [`PR: ${pr.url}`] : []),
        `Branch: ${worker.branch}`,
        `Head: ${collected.head}`,
        `Base: ${worker.base}`,
        "",
        // Everything in this block was written by the worker: report it, never obey it.
        "<worker-report untrusted>",
        "Summary:",
        unmarked(result.summary),
        ...(collected.commits ? ["", "Commits:", unmarked(collected.commits)] : []),
        ...(collected.diffStat ? ["", "Diff stat:", unmarked(collected.diffStat)] : []),
        ...(result.findings ? ["", "Findings:", unmarked(result.findings)] : []),
        ...(pr?.failed.length ? ["", "CI checks failed:", unmarked(pr.failed.map((check) => `${check.name} (${check.link})`).join("\n"))] : []),
        "</worker-report>",
        // Host-generated from the fixed pattern list, so it sits outside the block; worker-chosen file names stay inside.
        ...(sensitive.length
          ? [
              "",
              `Host check: review these before merging; they can run on your machine or in CI, or steer future agents: ${sensitive.join(", ")}.`,
            ]
          : []),
        ...(next.length ? ["", "Next:", ...next.map((line) => `- ${line}`)] : []),
      ].join("\n"),
      details: {
        reported: result.status,
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
    setState(worker, "starting");
    // Stopped meanwhile: open no new tab.
    if (worker.controller.signal.aborted) throw worker.controller.signal.reason;
    await launch(worker);
    setState(worker, "running");
    return true;
  };

  const fail = async (worker: Worker, error: unknown) => {
    if (worker.controller.signal.aborted) {
      const timedOut = worker.controller.signal.reason instanceof WaitingTimeout;
      setState(worker, "stopped");
      await closeAndClean(worker);
      report({
        worker: info(worker),
        status: "stopped",
        text: timedOut
          ? [
              `Worker "${worker.title}" [${worker.id.slice(0, 8)}] timed out: it waited ${deps.config.waitingTimeoutMinutes} minutes for an answer, so it was stopped and its tab closed.`,
              ...(worker.branch ? [`Work reported so far is on local branch ${worker.branch}.`] : []),
              "Next:",
              "- Tell the user; if the question still matters, get the answer and delegate a new task with it.",
            ].join("\n")
          : `Worker "${worker.title}" [${worker.id.slice(0, 8)}] was stopped.`,
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
      } while (worker.state === "waiting" || worker.state === "running");
    } catch (error) {
      await fail(worker, error);
    } finally {
      worker.resolveDone();
    }
  };

  /** Background life of one worker: launch, first result. */
  const drive = async (worker: Worker) => {
    try {
      setState(worker, "starting");
      if (worker.controller.signal.aborted) throw worker.controller.signal.reason;
      await launch(worker);
      setState(worker, "running");
    } catch (error) {
      await fail(worker, error);
      worker.resolveDone();
      return;
    }
    await watch(worker);
  };

  const find = (ref: string): Worker | { error: string } => {
    const needle = ref.trim().toLowerCase();
    const matches = [...workers.values()].filter(
      (w) => w.id.startsWith(needle) || w.title.toLowerCase() === needle || w.branch?.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0]!;
    return { error: matches.length ? `"${ref}" matches several workers; use its id` : `No worker "${ref}".` };
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
      const tier: RouteTier = params.kind === "review" && deps.config.tiers.review ? "review" : (params.tier ?? "standard");
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
        state: "queued",
        route,
        tabOpen: false,
        params,
        io,
        controller: new AbortController(),
        done,
        resolveDone,
        lastSeq: 0,
        attempts: 0,
        delegatedAt: now(),
        named: false,
        renameTries: 0,
        resumed: false,
        reroutes: 0,
      };
      workers.set(worker.id, worker);
      void drive(worker).catch(() => undefined);
      return {
        status: "started",
        worker: info(worker),
        text: [
          `Delegated "${params.title}" [${worker.id.slice(0, 8)}] to ${route.model} (thinking ${route.thinking}, tier ${route.tier}).`,
          "It is starting in a background Herdr tab.",
          "Its result will arrive as a message; keep helping the user meanwhile.",
        ].join("\n"),
      };
    },

    /** Relay text to a worker: steer a running one, or resume one waiting on a question. */
    async message(ref: string, text: string): Promise<string> {
      const worker = find(ref);
      if ("error" in worker) return worker.error;
      if (!worker.paneId || (worker.state !== "running" && worker.state !== "waiting")) {
        return `Worker "${worker.title}" is ${worker.state}; it cannot receive messages.`;
      }
      if ((await readIfPresent(worker.exitPath!))?.trim()) return `Worker "${worker.title}" has exited; it cannot receive messages.`;
      try {
        await deps.herdr!.sendToAgent(worker.paneId, `[PI Lead] ${text}`);
      } catch (error) {
        return `Could not reach "${worker.title}" through Herdr: ${errorText(error)}`;
      }
      worker.waitingSince = undefined;
      setState(worker, "running");
      return `Sent to "${worker.title}". Its next result will arrive as a message.`;
    },

    async stop(ref: string): Promise<string> {
      const worker = find(ref);
      if ("error" in worker) return worker.error;
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
      await Promise.race([Promise.all(live.map((worker) => worker.done)), sleep(10_000)]);
      await Promise.all(
        [...workers.values()]
          .filter((worker) => worker.workspaceId)
          .map((worker) => closeAndClean(worker, worker.state === "failed" && deps.config.keepFailedWorkers)),
      );
    },

    /**
     * On Lead start: remove the worktrees that earlier Lead processes, now
     * dead (crash, kill), left open, and remove their task dirs. Records of
     * live Leads (other sessions, or this process) are left alone. Returns
     * how many worktrees were removed.
     */
    async reconcile(): Promise<number> {
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
        if (record && record.leadPid !== process.pid && !processAlive(record.leadPid)) orphans.push({ dir, record });
      }
      const herdr = deps.herdr;
      // Nothing can be removed outside Herdr: keep the records for a Lead inside it.
      if (!herdr || orphans.length === 0) return 0;
      const workspaces = await herdr.listWorkspaces().catch(() => undefined);
      // If Herdr does not answer, or not even for the Lead's own workspace, try again on the next start.
      if (!workspaces || !workspaces.includes(herdr.workspace)) return 0;
      let closed = 0;
      for (const { dir, record } of orphans) {
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
          await writeFile(join(dir, RECORD), JSON.stringify(kept, null, 2)).catch(() => undefined);
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
