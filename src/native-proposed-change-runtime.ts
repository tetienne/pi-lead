import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { collectGitProposal, deliverGitProposal, prepareCommittedBase } from "./git-proposal.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { EffectivePiRoute, PiReasoningLevel } from "./model-reasoning-routing.ts";
import { parseEffectivePiRoute } from "./effective-route-observation.ts";
import { createProposedChangePolicy } from "./proposed-change-policy.ts";
import {
  ProposedChangeLaunchFailure,
  type ProposedChangeLaunchRequest,
  type ProposedChangeRuntime,
  ProposedChangeRuntimeFailure,
  type ProposedChangeWorker,
  type ProposedChangeWorkerResult,
  type ToolchainCacheTiming,
  type ValidationEvidence,
  type ReviewRequiredSummary,
} from "./proposed-change-task.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";
import {
  type GuestArchitecture,
  preparePrivateWorkerToolchain,
} from "./worker-toolchain-storage.ts";
import type { NativeWorkerCleanupObserver, NativeWorkerObserver, NativeWorkerResultObserver } from "./native-worker-observation.ts";

const execFileAsync = promisify(execFile);

export interface ProposedChangeProcessHost {
  start(request: { paneId: string; stateDirectory: string }): Promise<void>;
}

export type NativeProposedChangeRuntime = ProposedChangeRuntime & {
  commitProposal(
    proposal: ReviewRequiredSummary,
    branchName: string,
  ): Promise<{
    branchName: string;
    commit: string;
    committed: true;
    activeCheckoutPreserved: true;
  }>;
};

type NativeProposedChangeRuntimeOptions = {
  cwd: string;
  workerMode?: "change" | "research" | "validation-only";
  workerPhase?: "DEBUG" | "BUILD";
  guestArchitecture?: GuestArchitecture;
  modelId?: string;
  reasoning?: PiReasoningLevel;
  onWorkerSpawn?(effective: EffectivePiRoute): void;
  onWorkerOwned?: NativeWorkerObserver;
  onWorkerResult?: NativeWorkerResultObserver;
  onWorkerCleaned?: NativeWorkerCleanupObserver;
  workspaceId?: string;
  stateRoot?: string;
  workerToolchainRoot?: string;
  herdr?: HerdrClient;
  processHost?: ProposedChangeProcessHost;
  pollIntervalMs?: number;
};

type RunState = {
  directory: string;
  heartbeat: ReturnType<typeof setInterval>;
  worker: ProposedChangeWorker;
};

export function assertResearchNote(files: ReviewRequiredSummary["files"]): void {
  const note = files.length === 1 ? files[0] : undefined;
  const contents = note?.contentBase64 && !note.binary
    ? Buffer.from(note.contentBase64, "base64").toString("utf8")
    : "";
  if (!note || !note.path.endsWith(".md") || !contents.includes("https://")) {
    throw new Error("Matt research must return exactly one Markdown note with primary-source citations");
  }
}

function findStringField(value: unknown, field: string): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringField(entry, field);
      if (found) return found;
    }
  } else if (isRecord(value)) {
    if (typeof value[field] === "string") return value[field];
    for (const nested of Object.values(value)) {
      const found = findStringField(nested, field);
      if (found) return found;
    }
  }
  return undefined;
}

function findArrayField(value: unknown, field: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value[field])) return value[field];
  for (const nested of Object.values(value)) {
    const found = findArrayField(nested, field);
    if (found) return found;
  }
  return undefined;
}

async function runHerdr(args: string[]): Promise<unknown | undefined> {
  const { stdout } = await execFileAsync("herdr", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const trimmed = stdout.trim();
  return trimmed ? (JSON.parse(trimmed) as unknown) : undefined;
}

class NativeProposedChangeCliClient implements HerdrClient, ProposedChangeProcessHost {
  readonly #launcherPath = fileURLToPath(
    new URL("./proposed-change-launcher.ts", import.meta.url),
  );

  async createBackgroundTab(request: {
    workspaceId: string;
    cwd: string;
    label: string;
    focus: false;
  }): Promise<{ tabId: string; paneId: string }> {
    const response = await runHerdr([
      "tab",
      "create",
      "--workspace",
      request.workspaceId,
      "--cwd",
      request.cwd,
      "--label",
      request.label,
      "--no-focus",
    ]);
    const tabId = findStringField(response, "tab_id");
    const paneId = findStringField(response, "pane_id");
    if (!tabId || !paneId) throw new Error("Herdr did not return tab_id and pane_id");
    return { tabId, paneId };
  }

  async start(request: { paneId: string; stateDirectory: string }): Promise<void> {
    await runHerdr([
      "pane",
      "run",
      request.paneId,
      process.execPath,
      this.#launcherPath,
      request.stateDirectory,
    ]);
  }

  async tabExists(tabId: string): Promise<boolean> {
    const response = await runHerdr(["tab", "list"]);
    return (findArrayField(response, "tabs") ?? []).some(
      (tab) => isRecord(tab) && tab.tab_id === tabId,
    );
  }

  async closeTab(tabId: string): Promise<void> {
    await runHerdr(["tab", "close", tabId]);
  }
}

function inferWorkspaceId(): string {
  const paneId = process.env.HERDR_PANE_ID;
  const separator = paneId?.indexOf(":") ?? -1;
  if (!paneId || separator <= 0) {
    throw new Error("Native Herdr control unavailable: HERDR_PANE_ID is missing");
  }
  return paneId.slice(0, separator);
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForJson(
  path: string,
  options: { pollIntervalMs: number; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const value = await readJsonIfPresent(path);
    if (value !== undefined) return value;
    await wait(options.pollIntervalMs, options.signal);
  }
  throw new DOMException(`Timed out waiting for ${path}`, "TimeoutError");
}

async function waitForLaunchArtifact(
  directory: string,
  options: { pollIntervalMs: number; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const failure = await readJsonIfPresent(join(directory, "launch-error.json"));
    if (failure !== undefined) {
      throw new Error(requireString(failure, "detail", 16_384));
    }
    const resources = await readJsonIfPresent(join(directory, "resources.json"));
    if (resources !== undefined) return resources;
    await wait(options.pollIntervalMs, options.signal);
  }
  throw new DOMException("Timed out waiting for proposed-change worker resources", "TimeoutError");
}

function requireString(value: unknown, field: string, maxLength = 16_384): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].length > maxLength) {
    throw new Error(`Invalid proposed-change artifact: ${field}`);
  }
  return value[field];
}

function defaultGuestArchitecture(): GuestArchitecture {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  throw new Error(`Unsupported host architecture for Linux guest toolchains: ${process.arch}`);
}

function parseValidations(value: unknown): ValidationEvidence[] {
  if (!isRecord(value) || !Array.isArray(value.validations) || value.validations.length > 8) {
    throw new Error("Invalid proposed-change validations");
  }
  return value.validations.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.task !== "string" ||
      typeof entry.command !== "string" ||
      typeof entry.passed !== "boolean" ||
      typeof entry.exitCode !== "number" ||
      !Number.isSafeInteger(entry.exitCode)
    ) {
      throw new Error("Invalid proposed-change validation evidence");
    }
    return {
      task: entry.task,
      command: entry.command,
      passed: entry.passed,
      exitCode: entry.exitCode,
    };
  });
}

function parseToolchainCacheTiming(value: unknown): ToolchainCacheTiming | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.seedId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.seedId) ||
    (value.state !== "COLD" && value.state !== "WARM")
  ) {
    throw new Error("Invalid toolchain cache timing evidence");
  }
  const duration = (field: string): number => {
    const result = value[field];
    if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
      throw new Error("Invalid toolchain cache timing evidence");
    }
    return result;
  };
  return {
    seedId: value.seedId,
    state: value.state,
    seedCopyMs: duration("seedCopyMs"),
    guestToolchainPreparationMs: duration("guestToolchainPreparationMs"),
    miseReadinessMs: duration("miseReadinessMs"),
    validationExecutionMs: duration("validationExecutionMs"),
  };
}

function parseResult(value: unknown): ProposedChangeWorkerResult {
  if (!isRecord(value) || value.status !== "proposed") {
    throw new Error("Invalid proposed-change result");
  }
  return {
    status: "proposed",
    taskId: requireString(value, "taskId", 160),
    assignmentId: requireString(value, "assignmentId", 160),
    workerId: requireString(value, "workerId", 160),
    vmId: requireString(value, "vmId", 160),
    tabId: requireString(value, "tabId", 160),
    paneId: requireString(value, "paneId", 160),
    piSessionId: requireString(value, "piSessionId", 160),
    baseCommit: requireString(value, "baseCommit", 64),
    proposedCommit: requireString(value, "proposedCommit", 64),
    validations: parseValidations(value),
    toolchainCache: parseToolchainCacheTiming(value.toolchainCache),
  };
}

export async function createNativeProposedChangeRuntime(
  options: NativeProposedChangeRuntimeOptions,
): Promise<NativeProposedChangeRuntime> {
  const cli = new NativeProposedChangeCliClient();
  const herdr = options.herdr ?? cli;
  const processHost = options.processHost ?? cli;
  const stateRoot =
    options.stateRoot ??
    process.env.PI_LEAD_STATE_DIR ??
    join(homedir(), ".local", "state", "pi-lead");
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const runs = new Map<string, RunState>();
  const ownedRun = (proposal: ReviewRequiredSummary, action: string): RunState => {
    const run = runs.get(proposal.vmId);
    if (
      !run ||
      run.worker.taskId !== proposal.taskId ||
      run.worker.assignmentId !== proposal.assignmentId ||
      run.worker.workerId !== proposal.workerId ||
      run.worker.baseCommit !== proposal.baseCommit
    ) {
      throw new Error(`Cannot ${action} a proposal that is not owned by this runtime`);
    }
    return run;
  };

  return {
    async launch(
      request: ProposedChangeLaunchRequest,
      signal?: AbortSignal,
    ): Promise<ProposedChangeWorker> {
      if (
        request.repositoryPath !== options.cwd ||
        request.privateWorkspace !== true ||
        request.focus !== false ||
        request.hostMounts.length !== 0 ||
        request.allowedDependencyHosts.length !== request.dependencyHosts.length ||
        request.allowedDependencyHosts.some(
          (host, index) => host !== request.dependencyHosts[index],
        )
      ) {
        throw new Error("Proposed-change launch policy is inconsistent");
      }
      const workerId = randomUUID();
      const piSessionId = randomUUID();
      const runKey = createHash("sha256")
        .update(`${request.taskId}\0${request.assignmentId}\0${workerId}`)
        .digest("hex");
      const directory = join(stateRoot, runKey);
      let diagnosticsRetained = false;
      let launcherMayBeRunning = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        signal?.throwIfAborted();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const prepared = await prepareCommittedBase({
          repositoryPath: options.cwd,
          namedBase: request.namedBase,
          outputPath: join(directory, "base.bundle"),
        });
        const toolchainCache = await preparePrivateWorkerToolchain({
          root: options.workerToolchainRoot ?? join(stateRoot, "worker-toolchains"),
          workerId,
          guestArchitecture: options.guestArchitecture ?? defaultGuestArchitecture(),
        });
        const policy = createProposedChangePolicy({
          workerId,
          dependencyHosts: request.dependencyHosts,
          validationTasks: request.validationTasks,
          includeProviderHost: options.workerMode !== "validation-only",
        });
        const workspaceId = options.workspaceId ?? inferWorkspaceId();
        await writeFile(join(directory, "heartbeat"), new Date().toISOString(), {
          encoding: "utf8",
          mode: 0o600,
        });
        const tab = await herdr.createBackgroundTab({
          workspaceId,
          cwd: options.cwd,
          label: "PI Lead · proposed change",
          focus: false,
        });
        diagnosticsRetained = true;
        await writeJsonAtomically(join(directory, "launch.json"), {
          schemaVersion: 1,
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          instruction: request.instruction,
          namedBase: request.namedBase,
          baseCommit: prepared.baseCommit,
          workerId,
          piSessionId,
          tabId: tab.tabId,
          paneId: tab.paneId,
          modelId: options.modelId ?? "gpt-5.6-luna",
          reasoning: options.reasoning ?? "off",
          workerMode: options.workerMode ?? "change",
          toolchainCache,
          policy,
          controllerHeartbeatTimeoutMs: 5_000,
          controllerAdmissionRequired: true,
        });
        heartbeat = setInterval(() => {
          void writeFile(join(directory, "heartbeat"), new Date().toISOString(), "utf8");
        }, 1_000);
        heartbeat.unref();
        signal?.throwIfAborted();
        launcherMayBeRunning = true;
        await processHost.start({ paneId: tab.paneId, stateDirectory: directory });
        const resources = await waitForLaunchArtifact(directory, {
          pollIntervalMs,
          signal,
          timeoutMs: 180_000,
        });
        if (requireString(resources, "workerId", 160) !== workerId) {
          throw new Error("Launcher returned the wrong worker identity");
        }
        const worker: ProposedChangeWorker = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          workerId,
          vmId: requireString(resources, "vmId", 160),
          tabId: tab.tabId,
          paneId: tab.paneId,
          piSessionId,
          baseCommit: prepared.baseCommit,
        };
        const effectiveRoute = parseEffectivePiRoute(resources, "openai-codex", "proposed-change worker");
        if (options.onWorkerSpawn) options.onWorkerSpawn(effectiveRoute);
        if (options.onWorkerOwned) {
          await options.onWorkerOwned({ effectiveRoute, identity: worker, stateDirectory: directory, phase: options.workerPhase ?? "BUILD" });
        }
        await writeJsonAtomically(join(directory, "dispatch.json"), { admitted: true });
        runs.set(worker.vmId, { directory, heartbeat, worker });
        return worker;
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        let vmTerminated = !launcherMayBeRunning;
        if (launcherMayBeRunning) {
          await writeJsonAtomically(join(directory, "cancel.json"), { reason: "LAUNCH_ABORTED" });
          try {
            const termination = await waitForJson(join(directory, "termination.json"), {
              pollIntervalMs,
              timeoutMs: 40_000,
            });
            vmTerminated = isRecord(termination) && termination.terminated === true;
          } catch {
            vmTerminated = false;
          }
        }
        throw new ProposedChangeLaunchFailure(
          signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
            ? "CONTROLLER_TIMEOUT"
            : signal?.aborted
              ? "CANCELLED"
              : "NATIVE_CONTROL_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
          diagnosticsRetained,
          vmTerminated,
        );
      }
    },

    async waitForResult(
      worker: ProposedChangeWorker,
      signal?: AbortSignal,
    ): Promise<ProposedChangeWorkerResult> {
      const run = runs.get(worker.vmId);
      if (!run || run.worker.workerId !== worker.workerId) {
        throw new Error("Worker is not owned by this runtime");
      }
      while (true) {
        if (!(await herdr.tabExists(worker.tabId))) {
          await writeJsonAtomically(join(run.directory, "cancel.json"), { reason: "TERMINAL_LOST" });
          throw new Error("Worker terminal was closed");
        }
        const error = await readJsonIfPresent(join(run.directory, "error.json"));
        if (error !== undefined) {
          const detail = requireString(error, "detail", 16_384);
          throw new ProposedChangeRuntimeFailure(
            isRecord(error) && error.reason === "DEPENDENCY_DESTINATION_DENIED"
              ? "DEPENDENCY_DESTINATION_DENIED"
              : "RUNTIME_FAILURE",
            detail,
          );
        }
        const result = await readJsonIfPresent(join(run.directory, "result.json"));
        if (result !== undefined) {
          const parsed = parseResult(result);
          await options.onWorkerResult?.(worker);
          return parsed;
        }
        await wait(pollIntervalMs, signal);
      }
    },

    async collectResult(result: ProposedChangeWorkerResult) {
      const run = runs.get(result.vmId);
      if (!run || run.worker.workerId !== result.workerId) {
        throw new Error("Cannot collect a proposal for an unowned VM");
      }
      const collected = await collectGitProposal({
        baseCommit: result.baseCommit,
        bundlePath: join(run.directory, "proposal.bundle"),
        collectionDirectory: join(run.directory, "collection"),
      });
      if (collected.proposedCommit !== result.proposedCommit) {
        throw new Error("Collected proposal revision does not match the worker result");
      }
      if (options.workerMode === "research") {
        assertResearchNote(collected.files);
      }
      return { artifactId: collected.artifactId, files: collected.files };
    },

    async commitProposal(proposal: ReviewRequiredSummary, branchName: string) {
      const run = ownedRun(proposal, "commit");
      return deliverGitProposal({
        repositoryPath: options.cwd,
        baseCommit: proposal.baseCommit,
        proposedCommit: proposal.proposedCommit,
        artifactId: proposal.artifactId,
        bundlePath: join(run.directory, "proposal.bundle"),
        collectionDirectory: join(run.directory, "commit-collection"),
        branchName,
      });
    },

    async terminate(worker: ProposedChangeWorker): Promise<{ vmId: string; terminated: boolean }> {
      const run = runs.get(worker.vmId);
      if (!run) return { vmId: worker.vmId, terminated: false };
      await writeJsonAtomically(join(run.directory, "cancel.json"), { reason: "CONTROLLER_STOP" });
      let termination: unknown;
      try {
        termination = await waitForJson(join(run.directory, "termination.json"), {
          pollIntervalMs,
          timeoutMs: 10_000,
        });
      } catch {
        clearInterval(run.heartbeat);
        return { vmId: worker.vmId, terminated: false };
      }
      clearInterval(run.heartbeat);
      return {
        vmId: requireString(termination, "vmId", 160),
        terminated: isRecord(termination) && termination.terminated === true,
      };
    },

    async closeSuccessfulTab(tabId: string): Promise<void> {
      await herdr.closeTab(tabId);
      const run = [...runs.values()].find((candidate) => candidate.worker.tabId === tabId);
      if (run) await options.onWorkerCleaned?.(run.worker);
    },
  };
}
