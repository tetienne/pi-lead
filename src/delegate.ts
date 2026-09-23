import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig, Tier } from "./config.ts";
import type { Herdr } from "./herdr.ts";
import type { FailureKind, Judge, ReviewAction, WorkKind, WorkerVerdict } from "./jev.ts";
import { resolveRoute, type ModelRef, type WorkerRoute } from "./model-routing.ts";
import { parseWorkerResult, workerPrompt, type WorkerResult, type WorkerTask } from "./protocol.ts";
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
  /** Host directories the guest may read at the same path (skill folders, so skills can reference their files). */
  readonlyMounts?: readonly string[];
  stateRoot: string;
  /** Called for every result: first finish, each later finish, failures and stops. */
  onOutcome(outcome: DelegateOutcome): void;
  /** Short progress lines for the Lead's status bar. */
  onProgress?(text: string): void;
  pollMs?: number;
  heartbeatMs?: number;
};

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
        if (worker.state === "running") progress(`"${worker.title}" is working in its Herdr tab`);
        lastBeat = Date.now();
      }
      await sleep(pollMs, worker.controller.signal);
    }
  };

  const closeAndClean = async (worker: Worker) => {
    if (worker.tabId) await deps.herdr?.closeTab(worker.tabId).catch(() => undefined);
    worker.tabId = undefined;
    worker.paneId = undefined;
    if (worker.taskDir) await deps.workspace.remove(worker.taskDir).catch(() => undefined);
  };

  const launch = async (worker: Worker) => {
    const { params, io } = worker;
    worker.attempts += 1;
    worker.lastSeq = 0;
    await mkdir(deps.stateRoot, { recursive: true });
    worker.taskDir = await mkdtemp(join(deps.stateRoot, `${worker.id.slice(0, 8)}-`));
    worker.clonePath = join(worker.taskDir, "repo");
    worker.resultPath = join(worker.taskDir, "result.json");
    worker.exitPath = join(worker.taskDir, "exit");
    worker.repoRoot = await deps.workspace.repoRoot(io.cwd);
    worker.branch = `pi-lead/${slugify(params.title)}-${worker.id.slice(0, 6)}${worker.attempts > 1 ? `-${worker.attempts}` : ""}`;
    ({ base: worker.base } = await deps.workspace.create({
      repoRoot: worker.repoRoot,
      path: worker.clonePath,
      branch: worker.branch,
      ...(params.startFrom ? { startFrom: params.startFrom } : {}),
    }));
    // Before any guest touches the clone: copy what the host-side Pi will read.
    const workDir = join(worker.taskDir, "cwd");
    const resourceDir = join(worker.taskDir, "resources");
    const resources = await snapshotProjectResources({
      clonePath: worker.clonePath,
      workDir,
      resourceDir,
      projectTrusted: io.projectTrusted,
    });
    const toolchainCache = await deps.toolchains?.prepare({
      repoRoot: worker.repoRoot,
      clonePath: worker.clonePath,
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
      sandbox: deps.config.sandbox,
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
      prompt: workerPrompt(params.kind, params.task),
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
    });
    // Trust the more pessimistic of the worker and Jev.
    const status =
      jevVerdict && VERDICT_ORDER.indexOf(jevVerdict) > VERDICT_ORDER.indexOf(result.status) ? jevVerdict : result.status;
    const review = worker.kind === "review" && result.findings ? await deps.judge.reviewSeverity(result.findings) : undefined;
    const keep = status !== "done" && deps.config.keepFailedWorkers;
    worker.state = status === "done" ? "done" : keep ? "waiting" : "failed";
    if (!keep) await closeAndClean(worker);

    const id = worker.id.slice(0, 8);
    const next: string[] = [];
    if (keep) next.push(`The worker waits in its tab: relay what it needs with \`worker\` (action message, id ${id}), or stop it.`);
    if (status === "needs_human") next.push(keep ? "Ask the user for what the worker needs, then relay the answer." : "Ask the user for what the worker needed, then delegate a new task with the answer.");
    if (status === "partial" || status === "blocked") next.push("Tell the user what is left; continue only if they agree.");
    if (review?.action === "auto_fix") next.push("Review found fixable issues: delegate an implement task with these findings, starting from the reviewed branch.");
    if (review?.action === "escalate") next.push("Review found serious issues: show them to the user before doing anything else.");
    if (status === "done" && worker.kind !== "review") next.push(`Work is on local branch ${worker.branch}; nothing was pushed or merged.`);

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
      },
    });
  };

  const fail = async (worker: Worker, error: unknown) => {
    if (worker.controller.signal.aborted) {
      worker.state = "stopped";
      await closeAndClean(worker);
      report({
        worker: info(worker),
        status: "stopped",
        text: `Worker "${worker.title}" [${worker.id.slice(0, 8)}] was stopped.`,
        details: {},
      });
      return;
    }
    const failure = await deps.judge.failureKind({ task: worker.params.task, log: errorText(error) });
    const keep = deps.config.keepFailedWorkers;
    worker.state = "failed";
    if (!keep) await closeAndClean(worker);
    report({
      worker: info(worker),
      status: "failed",
      text: [
        ...header(worker),
        `Worker failed: ${errorText(error)}`,
        ...(failure ? [`Jev failure kind: ${failure}`] : []),
        ...(keep && worker.taskDir ? [`Tab and clone kept for inspection: ${worker.taskDir}`] : []),
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
        await settle(worker, result);
      } while (worker.state === "waiting");
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
          worker.state = "running";
          break;
        } catch (error) {
          if (worker.controller.signal.aborted || worker.attempts > 1) throw error;
          if ((await deps.judge.failureKind({ task: worker.params.task, log: errorText(error) })) !== "transient") throw error;
          progress(`"${worker.title}" failed to start transiently; retrying once`);
          await closeAndClean(worker);
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
      const route = resolveRoute(tier, deps.config.tiers, io.lead, io.available);
      if ("error" in route) return { status: "failed", text: `No worker model: ${route.error}.` };

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
      worker.state = "running";
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

    /** The Lead session ends: stop every worker that has not ended and wait for their cleanup. */
    async shutdown(): Promise<void> {
      const live = [...workers.values()].filter((worker) => !["done", "failed", "stopped"].includes(worker.state));
      for (const worker of live) worker.controller.abort(new Error("Lead session closed"));
      await Promise.race([Promise.all(live.map((worker) => worker.done)), sleep(10_000)]);
    },
  };
}

export type Delegator = ReturnType<typeof createDelegator>;
