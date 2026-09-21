import { mkdir, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUCCESS_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type TaskIdentity = {
  taskId: string;
  assignmentId: string;
  workerId: string;
  vmId: string;
  piSessionId: string;
  tabId: string;
  paneId: string;
};

export type DurableTaskAction = {
  id: string;
  kind: "PROMPT" | "PUSH";
  phase: "INTENDED" | "OBSERVED";
};

export type DurableTaskRecord = {
  schemaVersion: 1;
  taskId: string;
  status: "INTAKE" | "DISCOVER" | "DEBUG" | "PLAN" | "READY" | "BUILD" | "VERIFY" | "FIX" | "DONE" | "BLOCKED";
  blockedReason?: RecoveryReason;
  identity: TaskIdentity;
  baseCommit: string;
  finalCommit?: string;
  branchName: string;
  actions: readonly DurableTaskAction[];
  attempts: number;
  approvals: readonly { operation: string; fingerprint: string }[];
  verification: {
    finalRevisionVerified: boolean;
    checks: readonly string[];
    independentReviewArtifactIds: readonly string[];
    correctionCycles: number;
  };
  artifacts: readonly string[];
  cleanup: { vmTerminated: boolean; successfulTabClosed: boolean };
  diagnostics: {
    outcome: "SUCCESS" | "FAILURE" | "CLEARED";
    logDirectory: string;
    completedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type RecoveryReason =
  | "UNCERTAIN_ACTION"
  | "IDENTITY_MISMATCH"
  | "GIT_IDENTITY_MISMATCH"
  | "CLEANUP_UNCONFIRMED"
  | "DIAGNOSTIC_TAB_MISSING"
  | "RESUME_CONFIRMATION_REQUIRED";

export type RecoveryResult = {
  status: "BLOCKED";
  reason: RecoveryReason;
  diagnosticsRetained: true;
  resumeAllowed: boolean;
  record: DurableTaskRecord;
};

type ResourceState = "RUNNING" | "STOPPED" | "PRESENT" | "ABSENT" | "UNKNOWN";
type ResourceObservation = { state: ResourceState; identity?: TaskIdentity };
type TaskRecordWriter = { save(record: DurableTaskRecord): Promise<void> };

/**
 * Host-owned observations only. The absence of a launch or restore operation is
 * deliberate: recovery can reconcile and stop resources, but never replays work.
 */
export interface RecoveryRuntime {
  vm(identity: TaskIdentity): Promise<ResourceObservation>;
  pi(identity: TaskIdentity): Promise<ResourceObservation>;
  herdrTab(identity: TaskIdentity): Promise<ResourceObservation>;
  git(branchName: string): Promise<{ commit?: string }>;
  terminateVm(identity: TaskIdentity): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function recordPath(root: string, taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new Error("Invalid durable task ID");
  return resolve(root, "tasks", `${taskId}.json`);
}

function checkedLogDirectory(root: string, path: string): string {
  if (!path || path.includes("\0")) throw new Error("Invalid diagnostic log directory");
  const candidate = resolve(root, path);
  const pathFromRoot = relative(resolve(root), candidate);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Diagnostic log directory must remain inside task state");
  }
  return candidate;
}

function sameIdentity(expected: TaskIdentity, observed: TaskIdentity | undefined): boolean {
  return !!observed && (
    observed.taskId === expected.taskId &&
    observed.assignmentId === expected.assignmentId &&
    observed.workerId === expected.workerId &&
    observed.vmId === expected.vmId &&
    observed.piSessionId === expected.piSessionId &&
    observed.tabId === expected.tabId &&
    observed.paneId === expected.paneId
  );
}

function unobservedIntendedAction(record: DurableTaskRecord): DurableTaskAction | undefined {
  return record.actions.find(
    (action) => action.phase === "INTENDED" && !record.actions.some(
      (outcome) => outcome.id === action.id && outcome.kind === action.kind && outcome.phase === "OBSERVED",
    ),
  );
}

function blocked(
  record: DurableTaskRecord,
  reason: RecoveryReason,
  resumeAllowed: boolean,
): RecoveryResult {
  const updated = { ...record, status: "BLOCKED" as const, blockedReason: reason, updatedAt: nowIso() };
  return { status: "BLOCKED", reason, diagnosticsRetained: true, resumeAllowed, record: updated };
}

async function persistBlocked(
  writer: TaskRecordWriter,
  record: DurableTaskRecord,
  reason: RecoveryReason,
  resumeAllowed: boolean,
): Promise<RecoveryResult> {
  const result = blocked(record, reason, resumeAllowed);
  await writer.save(result.record);
  return result;
}

function validateRecord(value: unknown): DurableTaskRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.taskId !== "string" || !TASK_ID.test(value.taskId)) {
    throw new Error("Invalid durable task record");
  }
  if (
    !isRecord(value.identity) ||
    !["INTAKE", "DISCOVER", "DEBUG", "PLAN", "READY", "BUILD", "VERIFY", "FIX", "DONE", "BLOCKED"].includes(String(value.status)) ||
    !Array.isArray(value.actions) ||
    typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) || value.attempts < 1 ||
    !Array.isArray(value.approvals) ||
    !isRecord(value.verification) || !Array.isArray(value.verification.checks) || !Array.isArray(value.artifacts) ||
    !isRecord(value.cleanup) ||
    !isRecord(value.diagnostics) ||
    typeof value.baseCommit !== "string" ||
    typeof value.branchName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) throw new Error("Invalid durable task record");
  const identityFields = ["taskId", "assignmentId", "workerId", "vmId", "piSessionId", "tabId", "paneId"];
  const identity = value.identity;
  if (!isRecord(identity) || !identityFields.every((field) => typeof identity[field] === "string") || identity.taskId !== value.taskId) {
    throw new Error("Invalid durable task identity");
  }
  if (typeof value.cleanup.vmTerminated !== "boolean" || typeof value.cleanup.successfulTabClosed !== "boolean") {
    throw new Error("Invalid durable task cleanup state");
  }
  const verification = value.verification;
  if (
    !isRecord(verification) || typeof verification.finalRevisionVerified !== "boolean" ||
    !Array.isArray(verification.checks) || !Array.isArray(verification.independentReviewArtifactIds) ||
    typeof verification.correctionCycles !== "number" || !Number.isSafeInteger(verification.correctionCycles) || verification.correctionCycles < 0 || verification.correctionCycles > 2 ||
    !verification.checks.every((check) => typeof check === "string") ||
    !verification.independentReviewArtifactIds.every((artifact) => typeof artifact === "string") ||
    !value.artifacts.every((artifact) => typeof artifact === "string") ||
    !value.approvals.every((approval) =>
      isRecord(approval) && typeof approval.operation === "string" && typeof approval.fingerprint === "string",
    )
  ) throw new Error("Invalid durable task evidence");
  if (
    !["SUCCESS", "FAILURE", "CLEARED"].includes(String(value.diagnostics.outcome)) ||
    typeof value.diagnostics.logDirectory !== "string" ||
    (value.diagnostics.completedAt !== undefined && typeof value.diagnostics.completedAt !== "string")
  ) throw new Error("Invalid durable task diagnostics");
  if (value.diagnostics.outcome === "SUCCESS" && (!value.diagnostics.completedAt || !Number.isFinite(Date.parse(value.diagnostics.completedAt)))) {
    throw new Error("Successful task logs require a valid completion time");
  }
  if (!value.actions.every((action) =>
    isRecord(action) && typeof action.id === "string" &&
    (action.kind === "PROMPT" || action.kind === "PUSH") &&
    (action.phase === "INTENDED" || action.phase === "OBSERVED"),
  )) throw new Error("Invalid durable task actions");
  const actionCounts = new Map<string, { intended: number; observed: number }>();
  for (const action of value.actions as DurableTaskAction[]) {
    const key = `${action.kind}\0${action.id}`;
    const count = actionCounts.get(key) ?? { intended: 0, observed: 0 };
    count[action.phase === "INTENDED" ? "intended" : "observed"]++;
    actionCounts.set(key, count);
  }
  if ([...actionCounts.values()].some((count) => count.intended > 1 || count.observed > 1 || (count.observed > 0 && count.intended === 0))) {
    throw new Error("Invalid durable task action correlation");
  }
  if (
    value.status === "DONE" &&
    (!value.finalCommit || !value.cleanup.vmTerminated || !value.cleanup.successfulTabClosed ||
      !verification.finalRevisionVerified || verification.independentReviewArtifactIds.length < 2 ||
      value.artifacts.length === 0 || value.diagnostics.outcome === "FAILURE" || unobservedIntendedAction(value as DurableTaskRecord))
  ) throw new Error("DONE requires final revision verification and confirmed cleanup");
  return value as DurableTaskRecord;
}

export class TaskRecordStore {
  readonly #root: string;
  #pendingExclusive: Promise<void> = Promise.resolve();

  constructor(options: { root: string }) {
    this.#root = resolve(options.root);
  }

  async #openLease(lockPath: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        let owner: number | undefined;
        try {
          const contents = (await readFile(lockPath, "utf8")).trim();
          const parsed = Number(contents);
          if (Number.isSafeInteger(parsed) && parsed > 0) owner = parsed;
        } catch {
          throw new Error("Another PI Lead controller owns durable task recovery");
        }
        if (owner !== undefined) {
          try {
            process.kill(owner, 0);
            throw new Error("Another PI Lead controller owns durable task recovery");
          } catch (ownerError) {
            if (!isRecord(ownerError) || ownerError.code !== "ESRCH") {
              throw ownerError;
            }
          }
        } else {
          throw new Error("Another PI Lead controller owns durable task recovery");
        }
        await unlink(lockPath);
      }
    }
    throw new Error("Unable to acquire durable task recovery ownership");
  }

  /** Serializes a controller's load/modify/write cycle across process restarts. */
  async #exclusively<T>(work: (writer: TaskRecordWriter) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const previous = this.#pendingExclusive;
    this.#pendingExclusive = previous.then(() => next);
    await previous;
    const lockPath = join(this.#root, "controller.lock");
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const handle = await this.#openLease(lockPath);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      try {
        return await work({ save: (record) => this.#save(record) });
      } finally {
        await handle.close();
        await unlink(lockPath);
      }
    } finally {
      release?.();
    }
  }

  async save(record: DurableTaskRecord): Promise<void> {
    await this.#exclusively((writer) => writer.save(record));
  }

  async #save(record: DurableTaskRecord): Promise<void> {
    const valid = validateRecord(record);
    checkedLogDirectory(this.#root, valid.diagnostics.logDirectory);
    await writeJsonAtomically(recordPath(this.#root, valid.taskId), valid);
  }

  async load(taskId: string): Promise<DurableTaskRecord | undefined> {
    const value = await readJsonIfPresent(recordPath(this.#root, taskId));
    return value === undefined ? undefined : validateRecord(value);
  }

  async applyRetention(now: Date): Promise<string[]> {
    return this.#exclusively((writer) => this.#applyRetention(now, writer));
  }

  async #applyRetention(now: Date, writer: TaskRecordWriter): Promise<string[]> {
    const directory = resolve(this.#root, "tasks");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const expired: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.slice(0, -".json".length);
      if (!TASK_ID.test(taskId)) continue;
      const record = await this.load(taskId);
      const completedAt = record?.diagnostics.completedAt ? Date.parse(record.diagnostics.completedAt) : Number.NaN;
      if (
        !record || record.status !== "DONE" || record.diagnostics.outcome !== "SUCCESS" ||
        !Number.isFinite(completedAt) || now.getTime() - completedAt < SUCCESS_LOG_RETENTION_MS
      ) continue;
      await rm(checkedLogDirectory(this.#root, record.diagnostics.logDirectory), { recursive: true, force: true });
      await writer.save({
        ...record,
        diagnostics: { ...record.diagnostics, outcome: "CLEARED" },
        updatedAt: now.toISOString(),
      });
      expired.push(taskId);
    }
    return expired;
  }

  async clearFailureDiagnostics(taskId: string): Promise<void> {
    return this.#exclusively((writer) => this.#clearFailureDiagnostics(taskId, writer));
  }

  async #clearFailureDiagnostics(taskId: string, writer: TaskRecordWriter): Promise<void> {
    const record = await this.load(taskId);
    if (!record) throw new Error("Durable task record is missing");
    if (record.diagnostics.outcome !== "FAILURE") throw new Error("Only failure diagnostics require explicit clearing");
    await rm(checkedLogDirectory(this.#root, record.diagnostics.logDirectory), { recursive: true, force: true });
    await writer.save({
      ...record,
      diagnostics: { ...record.diagnostics, outcome: "CLEARED" },
      updatedAt: nowIso(),
    });
  }

  async reconcile(taskId: string, runtime: RecoveryRuntime): Promise<RecoveryResult> {
    return this.#exclusively((writer) => reconcileInterruptedTaskLocked(this, taskId, runtime, writer));
  }

  async confirmRecovery(taskId: string): Promise<DurableTaskRecord> {
    return this.#exclusively((writer) => confirmRecoveredTaskLocked(this, taskId, writer));
  }
}

export async function reconcileInterruptedTask(
  store: TaskRecordStore,
  taskId: string,
  runtime: RecoveryRuntime,
): Promise<RecoveryResult> {
  return store.reconcile(taskId, runtime);
}

async function reconcileInterruptedTaskLocked(
  store: TaskRecordStore,
  taskId: string,
  runtime: RecoveryRuntime,
  writer: TaskRecordWriter,
): Promise<RecoveryResult> {
  const record = await store.load(taskId);
  if (!record) throw new Error("Durable task record is missing");
  let vm: ResourceObservation;
  try {
    vm = await runtime.vm(record.identity);
    if (!sameIdentity(record.identity, vm.identity) && !(vm.state === "ABSENT" && vm.identity === undefined)) {
      return persistBlocked(writer, record, "IDENTITY_MISMATCH", false);
    }
    if (vm.state === "RUNNING") {
      if (!(await runtime.terminateVm(record.identity))) {
        return persistBlocked(writer, record, "CLEANUP_UNCONFIRMED", false);
      }
      vm = await runtime.vm(record.identity);
      if (!sameIdentity(record.identity, vm.identity) && !(vm.state === "ABSENT" && vm.identity === undefined)) {
        return persistBlocked(writer, record, "IDENTITY_MISMATCH", false);
      }
    }
  } catch {
    return persistBlocked(writer, record, "CLEANUP_UNCONFIRMED", false);
  }
  if (vm.state !== "STOPPED" && vm.state !== "ABSENT") return persistBlocked(writer, record, "CLEANUP_UNCONFIRMED", false);

  let pi: ResourceObservation;
  let tab: ResourceObservation;
  let git: { commit?: string };
  try {
    [pi, tab, git] = await Promise.all([
      runtime.pi(record.identity),
      runtime.herdrTab(record.identity),
      runtime.git(record.branchName),
    ]);
  } catch {
    return persistBlocked(writer, record, "CLEANUP_UNCONFIRMED", false);
  }
  if (
    (!sameIdentity(record.identity, pi.identity) && !(pi.state === "ABSENT" && pi.identity === undefined)) ||
    !sameIdentity(record.identity, tab.identity)
  ) {
    return persistBlocked(writer, record, "IDENTITY_MISMATCH", false);
  }
  if (pi.state !== "STOPPED" && pi.state !== "ABSENT") return persistBlocked(writer, record, "CLEANUP_UNCONFIRMED", false);
  if (tab.state !== "PRESENT") return persistBlocked(writer, record, "DIAGNOSTIC_TAB_MISSING", false);
  if (record.finalCommit && git.commit !== record.finalCommit) {
    return persistBlocked(writer, record, "GIT_IDENTITY_MISMATCH", false);
  }
  const reconciled = { ...record, cleanup: { ...record.cleanup, vmTerminated: true } };
  if (unobservedIntendedAction(reconciled)) return persistBlocked(writer, reconciled, "UNCERTAIN_ACTION", false);
  return persistBlocked(writer, reconciled, "RESUME_CONFIRMATION_REQUIRED", true);
}

export async function confirmRecoveredTask(
  store: TaskRecordStore,
  taskId: string,
): Promise<DurableTaskRecord> {
  return store.confirmRecovery(taskId);
}

async function confirmRecoveredTaskLocked(
  store: TaskRecordStore,
  taskId: string,
  writer: TaskRecordWriter,
): Promise<DurableTaskRecord> {
  const record = await store.load(taskId);
  if (!record) throw new Error("Durable task record is missing");
  if (unobservedIntendedAction(record)) throw new Error("Cannot resume with unresolved uncertain action");
  if (record.status !== "BLOCKED" || record.blockedReason !== "RESUME_CONFIRMATION_REQUIRED") {
    throw new Error("Task is not awaiting recovery confirmation");
  }
  const confirmed = { ...record, status: "READY" as const, blockedReason: undefined, updatedAt: nowIso() };
  await writer.save(confirmed);
  return confirmed;
}
