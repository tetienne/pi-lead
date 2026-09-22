import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";

export type LocalTicket = {
  id: string;
  title: string;
  sourcePath: string;
  sourceDigest: string;
  blockedBy: readonly string[];
  implementationAuthorized: boolean;
  status: "DONE" | "READY" | "BLOCKED";
};

export type ApprovedTicketGraph = {
  specificationPath: string;
  specificationDigest: string;
  tickets: readonly LocalTicket[];
  frontier: readonly LocalTicket[];
};

export type TicketContext = {
  ticket: LocalTicket;
  specificationPath: string;
  specificationDigest: string;
};

export type SchedulerClaim = {
  claimId: string;
  controllerId: string;
  assignmentId: string;
  attempt: number;
  ticket: LocalTicket;
  context: TicketContext;
};

export type InterruptedSchedulerClaim = SchedulerClaim & {
  reason: "RESUME_CONFIRMATION_REQUIRED";
  ownership?: WorkerOwnership;
};

export interface WorkerCapacity {
  use<T>(workers: 1 | 2, work: () => Promise<T>): Promise<T>;
}

export type WorkerOwnership = {
  ticketId: string;
  assignmentId: string;
  workerId: string;
  vmId: string;
  piSessionId: string;
  tabId: string;
  paneId: string;
};

export type VerifiedTicketResult = {
  status: "VERIFIED";
  baseRevision: string;
  verifiedRevision: string;
  touchedPaths: readonly string[];
  artifactIds: readonly string[];
  ownership: WorkerOwnership;
};

export type BlockedTicketResult = { status: "BLOCKED"; reason: string; detail: string };
export type TicketExecutionResult = VerifiedTicketResult | BlockedTicketResult;

export interface DependencyFrontierRuntime {
  execute(input: {
    claim: SchedulerClaim;
    workers: WorkerCapacity;
    recordWorkerOwnership(ownership: WorkerOwnership): Promise<void>;
    signal?: AbortSignal;
  }): Promise<TicketExecutionResult>;
  resolveOverlap(input: {
    ticket: LocalTicket;
    conflictingTicket: LocalTicket;
    result: VerifiedTicketResult;
    currentRevision: string;
  }): Promise<VerifiedTicketResult>;
  revalidate(input: {
    ticket: LocalTicket;
    result: VerifiedTicketResult;
    currentRevision: string;
  }): Promise<VerifiedTicketResult>;
  integrate(input: { ticket: LocalTicket; result: VerifiedTicketResult; currentRevision?: string }): Promise<{
    status: "INTEGRATED";
    revision: string;
  }>;
}

export type DependencyFrontierSummary = {
  status: "DONE" | "BLOCKED";
  completedTicketIds: readonly string[];
  blocked: readonly { ticketId: string; reason: string; detail: string }[];
  finalRevision?: string;
};

export type InterruptedClaimReason = "RESUME_CONFIRMATION_REQUIRED" | "CLEANUP_UNCONFIRMED";

export interface InterruptedWorkerRuntime {
  observe(ownership: WorkerOwnership): Promise<"RUNNING" | "STOPPED" | "UNKNOWN">;
  terminate(ownership: WorkerOwnership): Promise<boolean>;
}

export type InterruptedClaimReconciliation = {
  ticketId: string;
  assignmentId: string;
  reason: InterruptedClaimReason;
  resumeAllowed: boolean;
  ownership?: WorkerOwnership;
};

type TicketExecutionState = "PENDING" | "CLAIMED" | "DONE" | "BLOCKED" | "INTERRUPTED";
type PersistedTicket = {
  ticket: LocalTicket;
  state: TicketExecutionState;
  claimId?: string;
  controllerId?: string;
  assignmentId?: string;
  attempt: number;
  ownership?: WorkerOwnership;
  interruptionReason?: InterruptedClaimReason;
  artifactIds?: readonly string[];
  verifiedRevision?: string;
};
type SchedulerState = {
  schemaVersion: 1;
  specificationPath: string;
  specificationDigest: string;
  tickets: readonly PersistedTicket[];
};

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function ticketStatus(contents: string, sourcePath: string): LocalTicket["status"] {
  const match = /^\*\*Status:\*\*\s*(.+)$/im.exec(contents) ?? /^Status:\s*(.+)$/im.exec(contents);
  const value = match?.[1]?.trim().toUpperCase();
  if (value === "DONE") return "DONE";
  if (value === "READY-FOR-AGENT" || value === "READY") return "READY";
  if (value === "BLOCKED" || value === "IN PROGRESS") return "BLOCKED";
  throw new Error(`Ticket ${basename(sourcePath)} has no executable Status`);
}

function hasAcceptanceCriteria(contents: string): boolean {
  const heading = /^##\s+Acceptance criteria\s*$/im.exec(contents);
  if (!heading || heading.index === undefined) return false;
  const sectionStart = heading.index + heading[0].length;
  const following = contents.slice(sectionStart);
  const nextHeading = following.search(/^##\s/m);
  const section = nextHeading < 0 ? following : following.slice(0, nextHeading);
  return /^- \[[ xX]\]\s+\S/m.test(section);
}

function parseTicket(
  sourcePath: string,
  contents: string,
  implementationAuthorized: boolean,
): LocalTicket {
  const heading = /^#\s+(\d{2}):\s+(.+)$/m.exec(contents);
  if (!heading?.[1] || !heading[2]) throw new Error(`Ticket ${basename(sourcePath)} has an invalid heading`);
  const blockersLine = /^\*\*Blocked by:\*\*\s*(.+)$/im.exec(contents)?.[1]?.trim();
  if (!blockersLine) throw new Error(`Ticket ${basename(sourcePath)} has no blocking-edge declaration`);
  const hasNoBlockers = /^none(?:\b|\s)/i.test(blockersLine);
  const blockedBy = hasNoBlockers
    ? []
    : [...blockersLine.matchAll(/\[(\d{2}):[^\]]+\]\([^)]*\)/g)].map((match) => match[1]!);
  if (!hasNoBlockers && blockedBy.length === 0) {
    throw new Error(`Ticket ${basename(sourcePath)} has an invalid blocking-edge declaration`);
  }
  if (!hasAcceptanceCriteria(contents)) throw new Error(`Ticket ${basename(sourcePath)} has no acceptance criteria`);
  return {
    id: heading[1],
    title: heading[2].trim(),
    sourcePath,
    sourceDigest: digest(contents),
    blockedBy,
    implementationAuthorized,
    status: ticketStatus(contents, sourcePath),
  };
}

function specificationIsApproved(contents: string): boolean {
  return /^Approval:\s*approved by the user(?:,|\s*$)/im.test(contents);
}

/**
 * Loads the tracker rather than inferring work from filenames. A ticket context
 * includes its content digest so a later edit cannot silently reuse a claim.
 */
export async function loadApprovedTicketGraph(options: {
  specificationPath: string;
  ticketDirectory: string;
  authorizedTicketIds: readonly string[];
}): Promise<ApprovedTicketGraph> {
  const specificationPath = resolve(options.specificationPath);
  const specification = await readFile(specificationPath, "utf8");
  if (!specificationIsApproved(specification)) {
    throw new Error("Ticket graph requires an explicitly approved specification");
  }
  const ticketDirectory = resolve(options.ticketDirectory);
  const authorizedTicketIds = new Set(options.authorizedTicketIds);
  const ticketFiles = (await readdir(ticketDirectory))
    .filter((name) => /^\d{2}-.+\.md$/.test(name))
    .sort();
  if (ticketFiles.length === 0) throw new Error("Ticket graph contains no tickets");
  const tickets = await Promise.all(ticketFiles.map(async (name) => {
    const sourcePath = resolve(ticketDirectory, name);
    return parseTicket(
      sourcePath,
      await readFile(sourcePath, "utf8"),
      authorizedTicketIds.has(/^([0-9]{2})-/.exec(name)?.[1] ?? ""),
    );
  }));
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  if (byId.size !== tickets.length) throw new Error("Ticket graph has duplicate ticket IDs");
  for (const authorizedId of authorizedTicketIds) {
    if (!byId.has(authorizedId)) throw new Error(`Implementation authorization names unknown ticket ${authorizedId}`);
  }
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy) {
      if (!byId.has(blocker)) throw new Error(`Ticket ${ticket.id} has unknown blocking ticket ${blocker}`);
    }
  }
  const frontier = tickets.filter((ticket) =>
    ticket.status === "READY" && ticket.implementationAuthorized &&
      ticket.blockedBy.every((blocker) => byId.get(blocker)?.status === "DONE"),
  );
  return {
    specificationPath,
    specificationDigest: digest(specification),
    tickets,
    frontier,
  };
}

function validState(value: unknown): value is SchedulerState {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.specificationPath === "string" &&
    typeof value.specificationDigest === "string" &&
    Array.isArray(value.tickets) && value.tickets.every((entry) =>
      isRecord(entry) && isRecord(entry.ticket) && typeof entry.ticket.id === "string" &&
      ["PENDING", "CLAIMED", "DONE", "BLOCKED", "INTERRUPTED"].includes(String(entry.state)) &&
      (entry.claimId === undefined || typeof entry.claimId === "string") &&
      (entry.controllerId === undefined || typeof entry.controllerId === "string") &&
      typeof entry.attempt === "number" && Number.isSafeInteger(entry.attempt) && entry.attempt >= 0 &&
      (entry.assignmentId === undefined || typeof entry.assignmentId === "string"),
    );
}

function initialState(graph: ApprovedTicketGraph): SchedulerState {
  return {
    schemaVersion: 1,
    specificationPath: graph.specificationPath,
    specificationDigest: graph.specificationDigest,
    tickets: graph.tickets.map((ticket) => ({
      ticket,
      state: ticket.status === "DONE" ? "DONE" : ticket.status === "BLOCKED" ? "BLOCKED" : "PENDING",
      attempt: 0,
    })),
  };
}

function claimFrom(entry: PersistedTicket, graph: ApprovedTicketGraph): SchedulerClaim {
  if (!entry.claimId || !entry.controllerId || !entry.assignmentId || entry.attempt < 1) {
    throw new Error("Claimed ticket lacks ownership evidence");
  }
  const freshTicket = graph.tickets.find((ticket) => ticket.id === entry.ticket.id);
  if (!freshTicket || freshTicket.sourceDigest !== entry.ticket.sourceDigest) {
    throw new Error(`Ticket ${entry.ticket.id} changed after scheduler initialization; load a fresh graph`);
  }
  return {
    claimId: entry.claimId,
    controllerId: entry.controllerId,
    assignmentId: entry.assignmentId,
    attempt: entry.attempt,
    ticket: freshTicket,
    context: {
      ticket: freshTicket,
      specificationPath: graph.specificationPath,
      specificationDigest: graph.specificationDigest,
    },
  };
}

/**
 * Durable scheduler ownership for one consuming project. The file lease makes
 * selecting a frontier member atomic across Lead processes; interrupted claims
 * are retained as diagnostic state and deliberately cannot return to PENDING.
 */
export class DependencySchedulerStore {
  readonly #root: string;
  #withinProcess: Promise<void> = Promise.resolve();

  constructor(options: { root: string }) {
    this.#root = resolve(options.root);
  }

  #statePath(): string { return join(this.#root, "dependency-scheduler.json"); }
  #lockPath(): string { return join(this.#root, "dependency-scheduler.lock"); }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    let releaseQueue: (() => void) | undefined;
    const queued = new Promise<void>((resolvePromise) => { releaseQueue = resolvePromise; });
    const previous = this.#withinProcess;
    this.#withinProcess = previous.then(() => queued);
    await previous;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          handle = await open(this.#lockPath(), "wx", 0o600);
          await handle.writeFile(`${process.pid}\n`, "utf8");
          break;
        } catch (error) {
          if (!isRecord(error) || error.code !== "EEXIST") throw error;
          const owner = await readFile(this.#lockPath(), "utf8").then((contents) => Number(contents.trim())).catch(() => undefined);
          if (Number.isSafeInteger(owner) && owner! > 0) {
            try {
              process.kill(owner!, 0);
            } catch (ownerError) {
              if (isRecord(ownerError) && ownerError.code === "ESRCH") {
                await unlink(this.#lockPath());
                continue;
              }
              throw ownerError;
            }
          }
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
        }
      }
      if (!handle) throw new Error("Another PI Lead controller owns dependency scheduling");
      return await work();
    } finally {
      try { await handle?.close(); } finally {
        if (handle) await unlink(this.#lockPath());
        releaseQueue?.();
      }
    }
  }

  async #load(): Promise<SchedulerState | undefined> {
    const state = await readJsonIfPresent(this.#statePath());
    if (state === undefined) return undefined;
    if (!validState(state)) throw new Error("Invalid durable dependency scheduler state");
    return state;
  }

  async #save(state: SchedulerState): Promise<void> {
    if (!validState(state)) throw new Error("Invalid durable dependency scheduler state");
    await writeJsonAtomically(this.#statePath(), state);
  }

  async initialize(graph: ApprovedTicketGraph): Promise<void> {
    await this.#exclusive(async () => {
      const existing = await this.#load();
      if (!existing) return this.#save(initialState(graph));
      if (existing.specificationDigest !== graph.specificationDigest) {
        throw new Error("Approved specification changed after scheduler initialization; start a new task graph");
      }
      const changed = existing.tickets.some((entry) =>
        graph.tickets.find((ticket) => ticket.id === entry.ticket.id)?.sourceDigest !== entry.ticket.sourceDigest,
      );
      if (changed || existing.tickets.length !== graph.tickets.length) {
        throw new Error("Ticket graph changed after scheduler initialization; start a new task graph");
      }
    });
  }

  async claimFrontier(
    graph: ApprovedTicketGraph,
    request: { controllerId: string; availableWorkers: number },
  ): Promise<SchedulerClaim[]> {
    if (!request.controllerId.trim()) throw new Error("Scheduler claim requires a controller ID");
    if (!Number.isInteger(request.availableWorkers) || request.availableWorkers < 1 || request.availableWorkers > 2) {
      throw new Error("Scheduler workers must be between one and two");
    }
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before claiming work");
      if (state.specificationDigest !== graph.specificationDigest) throw new Error("Scheduler graph is stale");
      const active = state.tickets.filter((entry) => entry.state === "CLAIMED").length;
      const capacity = Math.max(0, Math.min(request.availableWorkers, 2 - active));
      const byId = new Map(state.tickets.map((entry) => [entry.ticket.id, entry]));
      const selected = state.tickets.filter((entry) =>
        entry.state === "PENDING" &&
          graph.tickets.find((ticket) => ticket.id === entry.ticket.id)?.implementationAuthorized &&
          entry.ticket.blockedBy.every((id) => byId.get(id)?.state === "DONE"),
      ).slice(0, capacity);
      const updated: SchedulerState = {
        ...state,
        tickets: state.tickets.map((entry) => selected.includes(entry)
          ? {
            ...entry,
            state: "CLAIMED" as const,
            claimId: randomUUID(),
            controllerId: request.controllerId,
            assignmentId: `${entry.ticket.id}:${randomUUID()}`,
            attempt: entry.attempt + 1,
          }
          : entry),
      };
      await this.#save(updated);
      return updated.tickets.filter((entry) => entry.state === "CLAIMED" && entry.controllerId === request.controllerId)
        .filter((entry) => selected.some((selectedEntry) => selectedEntry.ticket.id === entry.ticket.id))
        .map((entry) => claimFrom(entry, graph));
    });
  }

  async recoverInterrupted(controllerId?: string): Promise<InterruptedSchedulerClaim[]> {
    return this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before recovery");
      const interrupted = state.tickets.filter((entry) =>
        (entry.state === "CLAIMED" || entry.state === "INTERRUPTED") &&
          (controllerId === undefined || entry.controllerId === controllerId),
      );
      const updated: SchedulerState = {
        ...state,
        tickets: state.tickets.map((entry) => interrupted.includes(entry)
          ? { ...entry, state: "INTERRUPTED" as const }
          : entry),
      };
      await this.#save(updated);
      return interrupted.map((entry) => ({
        claimId: entry.claimId!, controllerId: entry.controllerId!, ticket: entry.ticket,
        assignmentId: entry.assignmentId!, attempt: entry.attempt,
        context: {
          ticket: entry.ticket,
          specificationPath: state.specificationPath,
          specificationDigest: state.specificationDigest,
        },
        ...(entry.ownership === undefined ? {} : { ownership: entry.ownership }),
        reason: "RESUME_CONFIRMATION_REQUIRED" as const,
      }));
    });
  }

  async completeClaim(
    claim: SchedulerClaim,
    outcome: "DONE" | "BLOCKED",
  ): Promise<void> {
    await this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before completing work");
      const entry = state.tickets.find((candidate) => candidate.ticket.id === claim.ticket.id);
      if (
        !entry || entry.state !== "CLAIMED" || entry.claimId !== claim.claimId ||
        entry.controllerId !== claim.controllerId || entry.assignmentId !== claim.assignmentId ||
        entry.attempt !== claim.attempt || entry.ticket.sourceDigest !== claim.ticket.sourceDigest
      ) throw new Error("Ticket completion does not match the current atomic claim");
      await this.#save({
        ...state,
        tickets: state.tickets.map((candidate) => candidate === entry
          ? { ...candidate, state: outcome, claimId: undefined, controllerId: undefined }
          : candidate),
      });
    });
  }

  async recordWorkerOwnership(claim: SchedulerClaim, ownership: WorkerOwnership): Promise<void> {
    if (
      ownership.ticketId !== claim.ticket.id || ownership.assignmentId !== claim.assignmentId ||
      ![ownership.workerId, ownership.vmId, ownership.piSessionId, ownership.tabId, ownership.paneId].every((id) => id.trim())
    ) throw new Error("Worker ownership does not match the claimed ticket assignment");
    await this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before recording worker ownership");
      const entry = state.tickets.find((candidate) => candidate.ticket.id === claim.ticket.id);
      if (
        !entry || entry.state !== "CLAIMED" || entry.claimId !== claim.claimId ||
        entry.assignmentId !== claim.assignmentId || entry.attempt !== claim.attempt
      ) throw new Error("Worker ownership does not match the current atomic claim");
      await this.#save({
        ...state,
        tickets: state.tickets.map((candidate) => candidate === entry ? { ...candidate, ownership } : candidate),
      });
    });
  }

  async recordVerifiedResult(claim: SchedulerClaim, result: VerifiedTicketResult): Promise<void> {
    await this.recordWorkerOwnership(claim, result.ownership);
    await this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before recording a result");
      const entry = state.tickets.find((candidate) => candidate.ticket.id === claim.ticket.id);
      if (!entry || entry.state !== "CLAIMED" || entry.claimId !== claim.claimId) {
        throw new Error("Verified result does not match the current atomic claim");
      }
      await this.#save({
        ...state,
        tickets: state.tickets.map((candidate) => candidate === entry
          ? { ...candidate, artifactIds: result.artifactIds, verifiedRevision: result.verifiedRevision }
          : candidate),
      });
    });
  }

  async recordInterruption(
    claimId: string,
    reason: InterruptedClaimReason,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const state = await this.#load();
      if (!state) throw new Error("Dependency scheduler must be initialized before recording interruption recovery");
      const entry = state.tickets.find((candidate) => candidate.state === "INTERRUPTED" && candidate.claimId === claimId);
      if (!entry) throw new Error("Interrupted ticket claim is no longer current");
      await this.#save({
        ...state,
        tickets: state.tickets.map((candidate) => candidate === entry ? { ...candidate, interruptionReason: reason } : candidate),
      });
    });
  }
}

class BoundedWorkerCapacity implements WorkerCapacity {
  #active = 0;
  readonly #limit: 2;
  readonly #waiting: Array<{
    workers: 1 | 2;
    start(): void;
  }> = [];

  constructor() { this.#limit = 2; }

  async use<T>(workers: 1 | 2, work: () => Promise<T>): Promise<T> {
    if (workers > this.#limit) throw new Error("Requested workers exceed policy capacity");
    await new Promise<void>((resolvePromise) => {
      const start = () => { this.#active += workers; resolvePromise(); };
      if (this.#active + workers <= this.#limit) start();
      else this.#waiting.push({ workers, start });
    });
    try {
      return await work();
    } finally {
      this.#active -= workers;
      this.#startWaiting();
    }
  }

  #startWaiting(): void {
    const next = this.#waiting.findIndex((waiting) => this.#active + waiting.workers <= this.#limit);
    if (next < 0) return;
    const waiting = this.#waiting.splice(next, 1)[0];
    waiting?.start();
    this.#startWaiting();
  }
}

function normalizedPaths(path: string): readonly string[] {
  return path.split(/\s+->\s+/).map((entry) => entry.replace(/^[ab]\//, "").replace(/\/+$/, ""));
}

function pathsOverlap(first: string, second: string): boolean {
  return normalizedPaths(first).some((left) => normalizedPaths(second).some((right) =>
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`),
  ));
}

function overlaps(first: readonly string[], second: readonly string[]): boolean {
  return first.some((left) => second.some((right) => pathsOverlap(left, right)));
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * Runs one observed frontier. Workers share a two-slot lease, while host-side
 * integration is intentionally serial. Call again after this frontier settles
 * to consider tickets newly unblocked by its completed dependencies.
 */
export async function runDependencyFrontier(options: {
  graph: ApprovedTicketGraph;
  store: DependencySchedulerStore;
  controllerId: string;
  runtime: DependencyFrontierRuntime;
  signal?: AbortSignal;
}): Promise<DependencyFrontierSummary> {
  await options.store.initialize(options.graph);
  const claims = await options.store.claimFrontier(options.graph, {
    controllerId: options.controllerId,
    availableWorkers: 2,
  });
  const workers = new BoundedWorkerCapacity();
  const executions = await Promise.all(claims.map(async (claim) => {
    try {
      return {
        claim,
        result: await options.runtime.execute({
          claim,
          workers,
          recordWorkerOwnership: (ownership) => options.store.recordWorkerOwnership(claim, ownership),
          signal: options.signal,
        }),
      };
    } catch (error) {
      if (isAbort(error, options.signal)) return { claim, interrupted: true as const };
      return {
        claim,
        result: {
          status: "BLOCKED" as const,
          reason: "RUNTIME_FAILURE",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }));
  if (executions.some((execution) => execution.interrupted)) {
    const interrupted = await options.store.recoverInterrupted(options.controllerId);
    return {
      status: "BLOCKED",
      completedTicketIds: [],
      blocked: interrupted.map((claim) => ({
        ticketId: claim.ticket.id,
        reason: claim.reason,
        detail: "Interrupted work requires explicit confirmation before resumption",
      })),
    };
  }

  const blocked: Array<{ ticketId: string; reason: string; detail: string }> = [];
  const verified: Array<{ claim: SchedulerClaim; result: VerifiedTicketResult }> = [];
  for (const execution of executions) {
    if (!execution.result) throw new Error("Unreachable scheduler execution state");
    if (execution.result.status === "BLOCKED") {
      await options.store.completeClaim(execution.claim, "BLOCKED");
      blocked.push({ ticketId: execution.claim.ticket.id, reason: execution.result.reason, detail: execution.result.detail });
    } else {
      verified.push({ claim: execution.claim, result: execution.result });
    }
  }

  let currentRevision: string | undefined;
  const integrated: Array<{ ticket: LocalTicket; result: VerifiedTicketResult }> = [];
  const completedTicketIds: string[] = [];
  for (const execution of verified) {
    let result = execution.result;
    const conflict = integrated.find((previous) => overlaps(previous.result.touchedPaths, result.touchedPaths));
    try {
      await options.store.recordVerifiedResult(execution.claim, result);
      if (conflict && currentRevision) {
        result = await options.runtime.resolveOverlap({
          ticket: execution.claim.ticket,
          conflictingTicket: conflict.ticket,
          result,
          currentRevision,
        });
      }
      if (currentRevision && result.verifiedRevision !== currentRevision) {
        result = await options.runtime.revalidate({ ticket: execution.claim.ticket, result, currentRevision });
      }
      const integration = await options.runtime.integrate({
        ticket: execution.claim.ticket,
        result,
        ...(currentRevision === undefined ? {} : { currentRevision }),
      });
      if (integration.status !== "INTEGRATED" || !integration.revision) throw new Error("Integration did not produce a revision");
      if (integration.revision !== result.verifiedRevision) {
        result = await options.runtime.revalidate({
          ticket: execution.claim.ticket,
          result,
          currentRevision: integration.revision,
        });
        if (result.verifiedRevision !== integration.revision) {
          throw new Error("Final-revision validation did not cover the integrated revision");
        }
      }
      currentRevision = integration.revision;
      integrated.push({ ticket: execution.claim.ticket, result });
      completedTicketIds.push(execution.claim.ticket.id);
      await options.store.completeClaim(execution.claim, "DONE");
    } catch (error) {
      await options.store.completeClaim(execution.claim, "BLOCKED");
      blocked.push({
        ticketId: execution.claim.ticket.id,
        reason: "INTEGRATION_BLOCKED",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    status: blocked.length === 0 ? "DONE" : "BLOCKED",
    completedTicketIds,
    blocked,
    ...(currentRevision === undefined ? {} : { finalRevision: currentRevision }),
  };
}

/**
 * Reconciliation is deliberately observation and termination only: it never
 * dispatches a prompt or returns a claim to PENDING. A later human confirmation
 * is required before new work can be admitted.
 */
export async function reconcileInterruptedFrontier(options: {
  store: DependencySchedulerStore;
  runtime: InterruptedWorkerRuntime;
}): Promise<readonly InterruptedClaimReconciliation[]> {
  const claims = await options.store.recoverInterrupted();
  return Promise.all(claims.map(async (claim) => {
    if (!claim.ownership) {
      await options.store.recordInterruption(claim.claimId, "RESUME_CONFIRMATION_REQUIRED");
      return {
        ticketId: claim.ticket.id,
        assignmentId: claim.assignmentId,
        reason: "RESUME_CONFIRMATION_REQUIRED" as const,
        resumeAllowed: true,
      };
    }
    let observed = await options.runtime.observe(claim.ownership);
    if (observed === "RUNNING" && await options.runtime.terminate(claim.ownership)) {
      observed = await options.runtime.observe(claim.ownership);
    }
    const reason: InterruptedClaimReason = observed === "STOPPED"
      ? "RESUME_CONFIRMATION_REQUIRED"
      : "CLEANUP_UNCONFIRMED";
    await options.store.recordInterruption(claim.claimId, reason);
    return {
      ticketId: claim.ticket.id,
      assignmentId: claim.assignmentId,
      reason,
      resumeAllowed: reason === "RESUME_CONFIRMATION_REQUIRED",
      ownership: claim.ownership,
    };
  }));
}
