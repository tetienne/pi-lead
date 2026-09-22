import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig, Tier } from "./config.ts";
import type { Herdr } from "./herdr.ts";
import type { FailureKind, Judge, ReviewAction, WorkKind, WorkerVerdict } from "./jev.ts";
import { resolveRoute, type ModelRef, type WorkerRoute } from "./model-routing.ts";
import { parseWorkerResult, workerPrompt, WORKER_SKILLS, type WorkerResult, type WorkerTask } from "./protocol.ts";
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

export type DelegateIO = {
  cwd: string;
  lead: ModelRef | undefined;
  available: readonly ModelRef[];
  signal?: AbortSignal;
  progress(text: string): void;
};

export type DelegateStatus = WorkerVerdict | "not_ready" | "failed" | "cancelled";

export type DelegateOutcome = {
  status: DelegateStatus;
  /** Returned to the Lead model as the tool result. */
  text: string;
  details: {
    id?: string;
    branch?: string;
    route?: WorkerRoute;
    tabKept?: boolean;
    reported?: WorkerVerdict;
    jevVerdict?: WorkerVerdict;
    review?: { severity: number; action: ReviewAction };
    failure?: FailureKind;
    missing?: string[];
  };
};

export type WorkerCommand = (input: {
  taskPath: string;
  prompt: string;
  route: WorkerRoute;
  skills: readonly string[];
  label: string;
}) => string[];

export type DelegateDeps = {
  config: LeadConfig;
  judge: Judge;
  herdr: Herdr | undefined;
  workspace: Workspace;
  workerCommand: WorkerCommand;
  stateRoot: string;
  pollMs?: number;
  heartbeatMs?: number;
};

type ActiveWorker = { id: string; kind: WorkKind; task: string; done: Promise<void> };

const WRITES_CODE: readonly WorkKind[] = ["implement", "debug"];

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

export function createDelegator(deps: DelegateDeps) {
  const active = new Map<string, ActiveWorker>();
  const pollMs = deps.pollMs ?? 1_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;

  /** Two code-writing tickets that Jev thinks overlap (or can't tell) run one after the other. */
  const mustWaitFor = async (other: ActiveWorker, params: DelegateParams): Promise<boolean> => {
    if (!WRITES_CODE.includes(other.kind) || !WRITES_CODE.includes(params.kind)) return false;
    return (await deps.judge.overlap(other.task, params.task)) ?? true;
  };

  const waitForSlot = async (params: DelegateParams, io: DelegateIO) => {
    while (true) {
      const blockers: ActiveWorker[] = [];
      for (const other of active.values()) if (await mustWaitFor(other, params)) blockers.push(other);
      if (blockers.length === 0 && active.size < deps.config.maxWorkers) return;
      io.progress(
        blockers.length > 0
          ? `waiting for overlapping worker(s): ${blockers.map((b) => b.id.slice(0, 6)).join(", ")}`
          : `waiting for a free worker slot (${active.size}/${deps.config.maxWorkers})`,
      );
      await Promise.race([...(blockers.length ? blockers : [...active.values()]).map((b) => b.done), sleep(heartbeatMs, io.signal)]);
    }
  };

  const waitForResult = async (path: string, id: string, label: string, io: DelegateIO): Promise<WorkerResult> => {
    let lastBeat = Date.now();
    while (true) {
      try {
        return parseWorkerResult(JSON.parse(await readFile(path, "utf8")), id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() - lastBeat >= heartbeatMs) {
        io.progress(`worker "${label}" is still running in its Herdr tab`);
        lastBeat = Date.now();
      }
      await sleep(pollMs, io.signal);
    }
  };

  const chooseRoute = async (params: DelegateParams, io: DelegateIO) => {
    const judged = await deps.judge.modelTier({ task: params.task, kind: params.kind });
    const tier: Tier = judged?.tier ?? (params.kind === "implement" || params.kind === "research" ? "standard" : "deep");
    const route = resolveRoute(tier, deps.config.tiers, io.lead, io.available);
    return { route, difficulty: judged?.difficulty };
  };

  /** One attempt: clone, open the tab, wait, collect. */
  const attempt = async (params: DelegateParams, io: DelegateIO, route: WorkerRoute) => {
    const id = randomUUID();
    const label = `lead: ${params.title}`.slice(0, 48);
    const branch = `pi-lead/${slugify(params.title)}-${id.slice(0, 6)}`;
    await mkdir(deps.stateRoot, { recursive: true });
    const taskDir = await mkdtemp(join(deps.stateRoot, `${id.slice(0, 8)}-`));
    const clonePath = join(taskDir, "repo");
    const repoRoot = await deps.workspace.repoRoot(io.cwd);
    const { base } = await deps.workspace.create({
      repoRoot,
      path: clonePath,
      branch,
      ...(params.startFrom ? { startFrom: params.startFrom } : {}),
    });

    const task: WorkerTask = {
      version: 1,
      id,
      kind: params.kind,
      title: params.title,
      task: params.task,
      branch,
      clonePath,
      resultPath: join(taskDir, "result.json"),
      sandbox: deps.config.sandbox,
      jev: deps.config.jev,
    };
    const taskPath = join(taskDir, "task.json");
    await writeFile(taskPath, JSON.stringify(task, null, 2));
    const argv = deps.workerCommand({
      taskPath,
      prompt: workerPrompt(params.kind, params.task),
      route,
      skills: WORKER_SKILLS[params.kind],
      label,
    });
    // `herdr pane run` gets one script path; the script owns argument quoting.
    const script = join(taskDir, "run.sh");
    await writeFile(script, `#!/bin/sh\ncd ${shellQuote(clonePath)} || exit 1\n${argv.map(shellQuote).join(" ")}\n`, { mode: 0o700 });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    active.set(id, { id, kind: params.kind, task: params.task, done });
    let tabId: string | undefined;
    try {
      ({ tabId } = await deps.herdr!.openWorkerTab({ label, cwd: clonePath, argv: ["/bin/sh", script] }));
      io.progress(`worker "${label}" started on ${route.model} (${route.thinking}) in a background Herdr tab`);
      const result = await waitForResult(task.resultPath, id, label, io);
      const collected = await deps.workspace.collect({ repoRoot, path: clonePath, branch, base });
      return { id, branch, base, tabId, taskDir, clonePath, result, collected };
    } catch (error) {
      return { id, branch, base, tabId, taskDir, clonePath, error };
    } finally {
      active.delete(id);
      resolveDone();
    }
  };

  const cleanup = async (run: { tabId?: string; clonePath: string }, keep: boolean) => {
    if (keep) return;
    if (run.tabId) await deps.herdr?.closeTab(run.tabId).catch(() => undefined);
    await deps.workspace.remove(run.clonePath).catch(() => undefined);
  };

  return {
    activeCount: () => active.size,

    async run(params: DelegateParams, io: DelegateIO): Promise<DelegateOutcome> {
      if (!deps.herdr) {
        return {
          status: "failed",
          text: "PI Lead workers need Herdr: start this Pi session inside a Herdr pane, then delegate again.",
          details: {},
        };
      }
      if (params.startFrom !== undefined && !isSafeBranchName(params.startFrom)) {
        return { status: "failed", text: `"${params.startFrom}" is not a valid local branch name.`, details: {} };
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
            text: [
              `Not delegated: Jev judged the ticket not ready (${readiness.missing.map((m) => reasons[m] ?? m).join("; ")}).`,
              "Clarify with the user (grilling), then to-spec / to-tickets, and delegate the resulting ticket.",
              "If the user confirms it is ready as is, call delegate again with confirmedReady: true.",
            ].join("\n"),
            details: { missing: readiness.missing },
          };
        }
      }

      const { route, difficulty } = await chooseRoute(params, io);
      if ("error" in route) return { status: "failed", text: `No worker model: ${route.error}.`, details: {} };

      await waitForSlot(params, io);

      let run = await attempt(params, io, route);
      if ("error" in run && !io.signal?.aborted) {
        const failure = await deps.judge.failureKind({ task: params.task, log: String(run.error) });
        if (failure === "transient") {
          io.progress("worker failed transiently; retrying once");
          await cleanup(run, false);
          run = await attempt(params, io, route);
        }
      }

      const header = [
        `Worker: ${route.model} · thinking ${route.thinking} · tier ${route.tier}` +
          (difficulty !== undefined ? ` (Jev difficulty ${difficulty.toFixed(1)}/4)` : " (default tier; Jev unavailable)"),
        ...(route.note ? [`Note: ${route.note}`] : []),
      ];

      if ("error" in run) {
        const cancelled = io.signal?.aborted === true;
        const failure = cancelled ? undefined : await deps.judge.failureKind({ task: params.task, log: String(run.error) });
        const keep = deps.config.keepFailedWorkers && !cancelled;
        await cleanup(run, keep);
        return {
          status: cancelled ? "cancelled" : "failed",
          text: [
            ...header,
            cancelled ? "Delegation cancelled." : `Worker failed: ${run.error instanceof Error ? run.error.message : String(run.error)}`,
            ...(failure ? [`Jev failure kind: ${failure}`] : []),
            ...(keep ? [`Tab and clone kept for inspection: ${run.taskDir}`] : []),
          ].join("\n"),
          details: { id: run.id, branch: run.branch, route, tabKept: keep, ...(failure ? { failure } : {}) },
        };
      }

      const { result, collected } = run;
      const jevVerdict = await deps.judge.verdict({
        task: params.task,
        reported: result.status,
        summary: result.summary,
        diffStat: collected.diffStat,
      });
      const order: WorkerVerdict[] = ["done", "partial", "blocked", "needs_human"];
      // Trust the more pessimistic of the worker and Jev.
      const status = jevVerdict && order.indexOf(jevVerdict) > order.indexOf(result.status) ? jevVerdict : result.status;
      const review = params.kind === "review" && result.findings ? await deps.judge.reviewSeverity(result.findings) : undefined;
      const keep = status !== "done" && deps.config.keepFailedWorkers;
      await cleanup(run, keep);

      const next: string[] = [];
      if (status === "needs_human") next.push("Ask the user for what the worker needs; its tab is still open for them.");
      if (status === "partial" || status === "blocked") next.push("Tell the user what is left; delegate a follow-up only if they agree.");
      if (review?.action === "auto_fix") next.push("Review found fixable issues: delegate an implement task with these findings, starting from the reviewed branch.");
      if (review?.action === "escalate") next.push("Review found serious issues: show them to the user before doing anything else.");
      if (status === "done" && params.kind !== "review") next.push(`Work is on local branch ${run.branch}; nothing was pushed or merged.`);

      return {
        status,
        text: [
          ...header,
          `Status: ${status}` + (jevVerdict && jevVerdict !== result.status ? ` (worker said ${result.status}, Jev said ${jevVerdict})` : ""),
          `Branch: ${run.branch}`,
          "",
          "Summary:",
          result.summary,
          ...(collected.commits ? ["", "Commits:", collected.commits] : []),
          ...(collected.diffStat ? ["", "Diff stat:", collected.diffStat] : []),
          ...(result.findings ? ["", "Findings:", result.findings] : []),
          ...(review ? ["", `Jev review severity: ${review.severity.toFixed(1)}/4 → ${review.action}`] : []),
          ...(next.length ? ["", "Next:", ...next.map((line) => `- ${line}`)] : []),
          ...(keep ? ["", `Tab and clone kept: ${run.taskDir}`] : []),
        ].join("\n"),
        details: {
          id: run.id,
          branch: run.branch,
          route,
          tabKept: keep,
          reported: result.status,
          ...(jevVerdict ? { jevVerdict } : {}),
          ...(review ? { review } : {}),
        },
      };
    },
  };
}
