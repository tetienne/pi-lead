import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig, Tier } from "./config.ts";
import { workspaceFromPaneId, type Herdr } from "./herdr.ts";
import type { FailureKind, Judge, ReviewAction, WorkKind, WorkerVerdict } from "./jev.ts";
import { resolveRoute, type ModelRef, type WorkerRoute } from "./model-routing.ts";
import { parseWorkerResult, workerPrompt, type WorkerResult, type WorkerTask } from "./protocol.ts";
import { providerOf, quotaPauseMinutes, type QuotaError } from "./quota.ts";
import { snapshotProjectResources, type ProjectResources } from "./context-snapshot.ts";
import type { Toolchains } from "./toolchains.ts";
import type { Workspace } from "./workspace.ts";

export type DelegateParams = {
  kind: WorkKind;
  title: string;
  task: string;
  /** Local branch to start from (reviews start from the branch under review). */
  startFrom?: string;
  /** The user explicitly confirmed the ticket is ready despite Jev's doubts. */
  confirmedReady?: boolean;
};

/** What the Lead's session knows when a task is delegated. */
export type DelegateIO = {
  cwd: string;
  lead: ModelRef | undefined;
  available: readonly ModelRef[];
  /** Whether the Lead trusts this project; workers then get its skills and prompts too. */
  projectTrusted: boolean;
  /** Ask the human in the Lead's UI (egress during toolchain installation). */
  confirm?: (question: string) => Promise<boolean>;
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
  tabOpen: boolean;
};

export type DelegateOutcome = {
  worker: WorkerInfo;
  status: WorkerVerdict | "failed" | "stopped";
  /** Delivered to the Lead model as a message. */
  text: string;
  details: {
    reported?: WorkerVerdict;
    jevVerdict?: WorkerVerdict;
    review?: { severity: number; action: ReviewAction };
    failure?: FailureKind;
    quota?: QuotaError;
  };
};

export type StartResult =
  | { status: "started" | "queued"; worker: WorkerInfo; text: string }
  | { status: "not_ready"; missing: string[]; text: string }
  | { status: "failed"; text: string };

export type WorkerCommand = (input: {
  taskPath: string;
  prompt: string;
  route: WorkerRoute;
  label: string;
  /** Host copies of the repository's skills, prompts and APPEND_SYSTEM.md (trusted projects). */
  resources: ProjectResources;
}) => string[];

export type DelegateDeps = {
  config: LeadConfig;
  judge: Judge;
  herdr: Herdr | undefined;
  workspace: Workspace;
  workerCommand: WorkerCommand;
  toolchains?: Toolchains;
  /** The Gondolin image selector for workers when the config names none (downloads it the first time). */
  image?(progress: (text: string) => void): Promise<string>;
  /** Host directories the guest may read at the same path (skill folders, so skills can reference their files). */
  readonlyMounts?: readonly string[];
  stateRoot: string;
  /** Called for every result: first finish, each later finish, failures and stops. */
  onOutcome(outcome: DelegateOutcome): void;
  /** Short progress lines for the Lead's status bar. */
  onProgress?(text: string): void;
  pollMs?: number;
  heartbeatMs?: number;
  /** Whether the Lead process that wrote a task record still runs (tests fake it). */
  processAlive?(pid: number): boolean;
  now?(): number;
};

/**
 * `tab.json` in each task dir, written by the Lead that owns it. A later Lead
 * uses it to close the tabs of a Lead that crashed or was killed.
 */
type TabRecord = {
  version: 1;
  leadPid: number;
  createdAt: string;
  tabId?: string;
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
  difficulty: number | undefined;
  controller: AbortController;
  done: Promise<void>;
  resolveDone(): void;
  taskDir?: string;
  clonePath?: string;
  repoRoot?: string;
  base?: string;
  tabId?: string;
  paneId?: string;
  resultPath?: string;
  exitPath?: string;
  lastSeq: number;
  attempts: number;
  createdAt?: string;
  /** When the worker started waiting on a question (waitingTimeoutMinutes). */
  waitingSince?: number;
  /** Herdr agent name: set once, tried at most twice per tab. */
  named: boolean;
  renameTries: number;
  /** Continues the branch of an attempt that ran out of quota. */
  resumed: boolean;
  reroutes: number;
};

const WRITES_CODE: readonly WorkKind[] = ["implement", "prototype", "debug"];
const VERDICT_ORDER: WorkerVerdict[] = ["done", "partial", "blocked", "needs_human"];

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
  const overlapCache = new Map<string, boolean>();
  // Slot decisions are serialized: two workers never pass the check at once.
  let scheduler: Promise<void> = Promise.resolve();
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
    tabOpen: worker.tabId !== undefined,
    ...(worker.branch ? { branch: worker.branch } : {}),
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

  /** Title, sidebar name and tokens of the worker's pane, reported on every state change. */
  const describe = (worker: Worker) => {
    const paneId = worker.paneId;
    if (!paneId) return;
    bestEffort(() =>
      deps.herdr?.reportMetadata(paneId, {
        title: worker.title,
        displayAgent: `pi-lead ${worker.kind}`,
        tokens: {
          model: worker.route.model,
          thinking: worker.route.thinking,
          ...(worker.branch ? { branch: worker.branch } : {}),
          worker: worker.id.slice(0, 8),
          state: worker.state,
        },
        workingLabel: `${worker.kind}: ${worker.title}`,
      }),
    );
  };

  const setState = (worker: Worker, state: WorkerState) => {
    worker.state = state;
    describe(worker);
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
      ...(worker.tabId ? { tabId: worker.tabId } : {}),
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

  /** Workers holding a slot. A waiting worker's VM idles on a question, so it does not count. */
  const busy = () => [...workers.values()].filter((w) => w.state === "starting" || w.state === "running");

  /** Two code-writing tickets that Jev thinks overlap (or can't tell) run one after the other. */
  const mustWaitFor = async (other: Worker, worker: Worker) => {
    if (!WRITES_CODE.includes(other.kind) || !WRITES_CODE.includes(worker.kind)) return false;
    const key = `${other.id}:${worker.id}`;
    let overlaps = overlapCache.get(key);
    if (overlaps === undefined) {
      overlaps = (await deps.judge.overlap(other.params.task, worker.params.task)) ?? true;
      overlapCache.set(key, overlaps);
    }
    return overlaps;
  };

  /** FIFO: each worker takes its slot in turn and is `starting` before the next one checks. */
  const takeSlot = (worker: Worker) => {
    const turn = scheduler.then(() => waitForSlot(worker)).then(() => {
      worker.state = "starting";
    });
    scheduler = turn.catch(() => undefined);
    // A stopped worker leaves the queue at once, not when its turn comes.
    const signal = worker.controller.signal;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => undefined);
    return Promise.race([turn, aborted]);
  };

  const waitForSlot = async (worker: Worker) => {
    while (true) {
      const others = busy().filter((other) => other !== worker);
      const blockers: Worker[] = [];
      for (const other of others) if (await mustWaitFor(other, worker)) blockers.push(other);
      if (blockers.length === 0 && others.length < deps.config.maxWorkers) return;
      progress(
        blockers.length > 0
          ? `"${worker.title}" waits for overlapping "${blockers.map((b) => b.title).join('", "')}"`
          : `"${worker.title}" waits for a free worker slot`,
      );
      await Promise.race([
        ...(blockers.length ? blockers : others).map((b) => b.done),
        sleep(heartbeatMs, worker.controller.signal),
      ]);
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
        if (worker.state === "running") {
          progress(`"${worker.title}" is working in its Herdr tab`);
          // By now Herdr has detected the Pi, if the name failed at tab creation.
          nameAgent(worker);
        }
        lastBeat = Date.now();
      }
      // An unanswered question must not keep a VM up forever: the abort ends in `fail`.
      if (worker.state === "waiting" && waitingTimeoutMs > 0 && Date.now() - (worker.waitingSince ?? 0) >= waitingTimeoutMs) {
        worker.controller.abort(new WaitingTimeout(`no answer within ${deps.config.waitingTimeoutMinutes} minutes`));
      }
      await sleep(pollMs, worker.controller.signal);
    }
  };

  /** Close the tab (which kills its Pi and VM), then remove the task dir unless it is kept for inspection. */
  const closeAndClean = async (worker: Worker, keepDir = false) => {
    if (worker.tabId) await deps.herdr?.closeTab(worker.tabId).catch(() => undefined);
    worker.tabId = undefined;
    worker.paneId = undefined;
    if (!worker.taskDir) return;
    if (keepDir) await writeRecord(worker); // no tab left to close
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
    worker.clonePath = join(worker.taskDir, "repo");
    worker.resultPath = join(worker.taskDir, "result.json");
    worker.exitPath = join(worker.taskDir, "exit");
    worker.repoRoot = await deps.workspace.repoRoot(io.cwd);
    worker.branch = `pi-lead/${slugify(params.title)}-${worker.id.slice(0, 6)}${worker.attempts > 1 ? `-${worker.attempts}` : ""}`;
    const created = await deps.workspace.create({
      repoRoot: worker.repoRoot,
      path: worker.clonePath,
      branch: worker.branch,
      ...(params.startFrom ? { startFrom: params.startFrom } : {}),
    });
    // A resumed attempt starts from the previous branch; its report still covers everything since the first base.
    worker.base ??= created.base;
    // Before any guest touches the clone: copy what the host-side Pi will read.
    const workDir = join(worker.taskDir, "cwd");
    const resourceDir = join(worker.taskDir, "resources");
    const resources = await snapshotProjectResources({
      clonePath: worker.clonePath,
      workDir,
      resourceDir,
      projectTrusted: io.projectTrusted,
    });
    const sandbox =
      deps.config.sandbox.image || !deps.image ? deps.config.sandbox : { ...deps.config.sandbox, image: await deps.image(progress) };
    const toolchainCache = await deps.toolchains?.prepare({
      repoRoot: worker.repoRoot,
      clonePath: worker.clonePath,
      sandbox,
      progress,
      ...(io.confirm ? { confirm: io.confirm } : {}),
    });
    const task: WorkerTask = {
      version: 1,
      id: worker.id,
      kind: params.kind,
      title: params.title,
      task: params.task,
      branch: worker.branch,
      clonePath: worker.clonePath,
      resultPath: worker.resultPath,
      sandbox,
      jev: deps.config.jev,
      readonlyMounts: [
        ...(deps.readonlyMounts ?? []),
        ...(resources.skills.length || resources.prompts.length || resources.appendSystem ? [resourceDir] : []),
      ],
      ...(toolchainCache ? { toolchainCache } : {}),
    };
    const taskPath = join(worker.taskDir, "task.json");
    await writeFile(taskPath, JSON.stringify(task, null, 2));
    const label = `lead: ${params.title}`.slice(0, 48);
    const argv = deps.workerCommand({
      taskPath,
      prompt: workerPrompt(params.kind, params.task) + (worker.resumed ? RESUME_NOTE : ""),
      route: worker.route,
      label,
      resources,
    });
    const script = join(worker.taskDir, "run.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        // Pi's cwd is outside the clone: host-side Pi (footer, context files)
        // never reads guest-writable files or git config.
        `cd ${shellQuote(workDir)} || exit 1`,
        // Lets Herdr recognise the Pi behind the node process as a Pi agent.
        "export HERDR_AGENT=pi",
        argv.map(shellQuote).join(" "),
        `echo $? > ${shellQuote(worker.exitPath)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    // `herdr pane run` types one command line into the tab's shell. That
    // shell's cwd is the task directory, never the clone: a prompt running
    // `git status` must not execute guest-planted git config on the host.
    ({ tabId: worker.tabId, paneId: worker.paneId } = await deps.herdr!.openWorkerTab({
      label,
      cwd: worker.taskDir,
      command: `/bin/sh ${shellQuote(script)}`,
    }));
    await writeRecord(worker);
    describe(worker);
    nameAgent(worker);
    progress(`"${worker.title}" started on ${worker.route.model} (${worker.route.thinking})`);
  };

  const header = (worker: Worker) => [
    `Worker "${worker.title}" [${worker.id.slice(0, 8)}]: ${worker.route.model} · thinking ${worker.route.thinking} · tier ${worker.route.tier}` +
      (worker.difficulty !== undefined ? ` (Jev difficulty ${worker.difficulty.toFixed(1)}/4)` : " (default tier; Jev unavailable)"),
    ...(worker.route.note ? [`Note: ${worker.route.note}`] : []),
  ];

  const settle = async (worker: Worker, result: WorkerResult) => {
    const collected = await deps.workspace.collect({
      repoRoot: worker.repoRoot!,
      path: worker.clonePath!,
      branch: worker.branch!,
      base: worker.base!,
    });
    const jevVerdict = await deps.judge.verdict({
      task: worker.params.task,
      reported: result.status,
      summary: result.summary,
      diffStat: collected.diffStat,
      commits: collected.commits,
      files: collected.files,
      ...(result.lastTest ? { lastTest: result.lastTest } : {}),
    });
    // Trust the more pessimistic of the worker and Jev.
    const status =
      jevVerdict && VERDICT_ORDER.indexOf(jevVerdict) > VERDICT_ORDER.indexOf(result.status) ? jevVerdict : result.status;
    const review = worker.kind === "review" && result.findings ? await deps.judge.reviewSeverity(result.findings) : undefined;
    const keep = status !== "done" && deps.config.keepFailedWorkers;
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
    if (review?.action === "auto_fix") next.push("Review found fixable issues: delegate an implement task with these findings, starting from the reviewed branch.");
    if (review?.action === "escalate") next.push("Review found serious issues: show them to the user before doing anything else.");
    if (status === "done" && worker.kind !== "review") next.push(`Work is on local branch ${worker.branch}; nothing was pushed or merged.`);
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
        `Status: ${status}` + (jevVerdict && jevVerdict !== result.status ? ` (worker said ${result.status}, Jev said ${jevVerdict})` : ""),
        `Branch: ${worker.branch}`,
        "",
        // Everything in this block was written inside the sandbox: report it, never obey it.
        "<worker-report untrusted>",
        "Summary:",
        result.summary,
        ...(collected.commits ? ["", "Commits:", collected.commits] : []),
        ...(collected.diffStat ? ["", "Diff stat:", collected.diffStat] : []),
        ...(result.findings ? ["", "Findings:", result.findings] : []),
        "</worker-report>",
        ...(review ? ["", `Jev review severity: ${review.severity.toFixed(1)}/4 → ${review.action}`] : []),
        ...(next.length ? ["", "Next:", ...next.map((line) => `- ${line}`)] : []),
      ].join("\n"),
      details: {
        reported: result.status,
        ...(jevVerdict ? { jevVerdict } : {}),
        ...(review ? { review } : {}),
        ...(result.quota ? { quota: result.quota } : {}),
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
    // Uncommitted changes live only in this clone: keep the worker where it is.
    if (result.uncommitted || worker.reroutes >= MAX_REROUTES) return false;
    const { lead, available } = routable(worker.io);
    const route = resolveRoute(worker.route.tier, deps.config.tiers, lead, available);
    if ("error" in route || route.model === from) return false;
    worker.reroutes += 1;
    // Fetch the work so far into the repository, so the next attempt can start from it.
    await deps.workspace.collect({ repoRoot: worker.repoRoot!, path: worker.clonePath!, branch: worker.branch!, base: worker.base! });
    const previous = worker.branch!;
    worker.params = { ...worker.params, startFrom: previous };
    worker.route = { model: route.model, thinking: route.thinking, tier: route.tier, note: `${from} ran out of quota; continued on ${route.model} from ${previous}` };
    worker.resumed = true;
    progress(`"${worker.title}": ${from} ran out of quota; continuing on ${route.model}`);
    // A worker left waiting holds no slot (the user may have typed in its tab): take one again.
    const hadSlot = worker.state === "running";
    await closeAndClean(worker);
    if (hadSlot) setState(worker, "starting");
    else await takeSlot(worker);
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
    const failure = await deps.judge.failureKind({ task: worker.params.task, log: errorText(error) });
    const keep = deps.config.keepFailedWorkers;
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
        ...(failure ? [`Jev failure kind: ${failure}`] : []),
        ...(keep && worker.taskDir
          ? [`Kept for inspection: ${worker.taskDir} (its tab closes when this Lead session ends; the directory stays).`]
          : []),
      ].join("\n"),
      details: failure ? { failure } : {},
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

  /** Background life of one worker: slot, launch (one retry when transient), first result. */
  const drive = async (worker: Worker) => {
    try {
      await takeSlot(worker);
      while (true) {
        try {
          await launch(worker);
          setState(worker, "running");
          break;
        } catch (error) {
          if (worker.controller.signal.aborted || worker.attempts > 1) throw error;
          if ((await deps.judge.failureKind({ task: worker.params.task, log: errorText(error) })) !== "transient") throw error;
          progress(`"${worker.title}" failed to start transiently; retrying once`);
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
      if (params.kind === "implement" && !params.confirmedReady) {
        const readiness = await deps.judge.readiness(params.task);
        if (readiness && !readiness.ready) {
          const reasons: Record<string, string> = {
            acceptance: "no verifiable acceptance criteria",
            bounded: "scope is not one bounded slice",
            decided: "open product/design decisions",
          };
          return {
            status: "not_ready",
            missing: readiness.missing,
            text: [
              `Not delegated: Jev judged the ticket not ready (${readiness.missing.map((m) => reasons[m] ?? m).join("; ")}).`,
              "Clarify with the user (grilling), then to-spec / to-tickets, and delegate the resulting ticket.",
              "If the user confirms it is ready as is, call delegate again with confirmedReady: true.",
            ].join("\n"),
          };
        }
      }
      const judged = await deps.judge.modelTier({ task: params.task, kind: params.kind });
      const tier: Tier = judged?.tier ?? (params.kind === "debug" || params.kind === "review" ? "deep" : "standard");
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
        difficulty: judged?.difficulty,
        controller: new AbortController(),
        done,
        resolveDone,
        lastSeq: 0,
        attempts: 0,
        named: false,
        renameTries: 0,
        resumed: false,
        reroutes: 0,
      };
      // Workers still in the queue will take slots before this one.
      const ahead = [...workers.values()].filter((w) => ["queued", "starting", "running"].includes(w.state)).length;
      const queued = ahead >= deps.config.maxWorkers;
      workers.set(worker.id, worker);
      void drive(worker).catch(() => undefined);
      return {
        status: queued ? "queued" : "started",
        worker: info(worker),
        text: [
          `Delegated "${params.title}" [${worker.id.slice(0, 8)}] to ${route.model} (thinking ${route.thinking}, tier ${route.tier}` +
            (judged ? `, Jev difficulty ${judged.difficulty.toFixed(1)}/4).` : ", default tier)."),
          queued ? "It is queued behind other workers." : "It is starting in a background Herdr tab.",
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
        if (worker.tabId) await closeAndClean(worker);
        return `Worker "${worker.title}" is already ${worker.state}; its tab is closed.`;
      }
      // The watcher sees the abort, closes the tab, removes the clone and reports.
      worker.controller.abort(new Error("stopped by the Lead"));
      return `Stopping "${worker.title}".`;
    },

    /**
     * The Lead session ends: stop every worker that has not ended (waiting ones
     * included) and wait for their cleanup, then close every tab still open.
     * Only the Lead's own pane outlives it; a failed worker keeps its directory
     * (keepFailedWorkers) but never its tab, whose Pi may still run a VM.
     */
    async shutdown(): Promise<void> {
      const live = [...workers.values()].filter((worker) => !["done", "failed", "stopped"].includes(worker.state));
      for (const worker of live) worker.controller.abort(new Error("Lead session closed"));
      await Promise.race([Promise.all(live.map((worker) => worker.done)), sleep(10_000)]);
      await Promise.all(
        [...workers.values()]
          .filter((worker) => worker.tabId)
          .map((worker) => closeAndClean(worker, worker.state === "failed" && deps.config.keepFailedWorkers)),
      );
    },

    /**
     * On Lead start: close the tabs that earlier Lead processes, now dead
     * (crash, kill), left open, and remove their task dirs. Records of live
     * Leads (other sessions, or this process) are left alone. Returns how
     * many tabs were closed.
     */
    async reconcile(): Promise<number> {
      const herdr = deps.herdr;
      // Nothing can be closed outside Herdr: keep the records for a Lead inside it.
      if (!herdr) return 0;
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
      if (orphans.length === 0) return 0;
      // If Herdr does not answer for the Lead's own workspace, try again on the next start.
      const listings = new Map<string, Promise<string[] | undefined>>();
      const tabsIn = (workspace: string) => {
        if (!listings.has(workspace)) listings.set(workspace, herdr.listTabs(workspace).catch(() => undefined));
        return listings.get(workspace)!;
      };
      if (!(await tabsIn(herdr.workspace))) return 0;
      let closed = 0;
      for (const { dir, record } of orphans) {
        if (record.tabId) {
          // Herdr answered for our workspace, so a workspace it cannot list is gone with its tabs.
          const tabs = (await tabsIn(workspaceFromPaneId(record.tabId) ?? herdr.workspace)) ?? [];
          if (tabs.includes(record.tabId)) {
            try {
              await herdr.closeTab(record.tabId);
              closed += 1;
            } catch {
              continue; // keep the record: the tab may still run a VM
            }
          }
        }
        if (record.failed && deps.config.keepFailedWorkers) {
          const { tabId: _tab, paneId: _pane, ...kept } = record;
          await writeFile(join(dir, RECORD), JSON.stringify(kept, null, 2)).catch(() => undefined);
        } else {
          await deps.workspace.remove(dir).catch(() => undefined);
        }
      }
      if (closed) progress(`closed ${closed} worker tab${closed === 1 ? "" : "s"} left by an earlier Lead`);
      return closed;
    },
  };
}

export type Delegator = ReturnType<typeof createDelegator>;
