import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createIsolatedFixturePolicy } from "./policy.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";
import type {
  CollectedFixtureResult,
  FixtureLaunchRequest,
  FixtureResult,
  FixtureRuntime,
  OwnedWorker,
} from "./task-lifecycle.ts";
import { FixtureLaunchFailure } from "./task-lifecycle.ts";
import type { NativeWorkerCleanupObserver, NativeWorkerObserver, NativeWorkerResultObserver } from "./native-worker-observation.ts";

const execFileAsync = promisify(execFile);

export type { HerdrClient } from "./herdr-client.ts";

export interface FixtureProcessHost {
  start(request: { paneId: string; stateDirectory: string }): Promise<void>;
}

type NativeRuntimeOptions = {
  cwd: string;
  fixtureHoldMs?: number;
  workspaceId?: string;
  stateRoot?: string;
  herdr?: HerdrClient;
  processHost?: FixtureProcessHost;
  pollIntervalMs?: number;
  onWorkerOwned?: NativeWorkerObserver;
  onWorkerResult?: NativeWorkerResultObserver;
  onWorkerCleaned?: NativeWorkerCleanupObserver;
};

type RunState = {
  directory: string;
  heartbeat: ReturnType<typeof setInterval>;
  worker: OwnedWorker;
};

function findStringField(value: unknown, field: string): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringField(entry, field);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value[field] === "string") return value[field];
  for (const nested of Object.values(value)) {
    const found = findStringField(nested, field);
    if (found) return found;
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

export function parseHerdrOutput(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  return trimmed ? (JSON.parse(trimmed) as unknown) : undefined;
}

async function runHerdr(args: string[]): Promise<unknown | undefined> {
  const { stdout } = await execFileAsync("herdr", args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return parseHerdrOutput(stdout);
}

class HerdrCliClient implements HerdrClient, FixtureProcessHost {
  readonly #launcherPath = fileURLToPath(new URL("./fixture-launcher.ts", import.meta.url));
  readonly #viewerPath = fileURLToPath(new URL("./fixture-viewer.ts", import.meta.url));

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
      this.#viewerPath,
      request.stateDirectory,
    ]);
    await new Promise<void>((resolve, reject) => {
      const launcher = spawn(process.execPath, [this.#launcherPath, request.stateDirectory], {
        stdio: "ignore",
      });
      launcher.once("spawn", resolve);
      launcher.once("error", reject);
    });
  }

  async tabExists(tabId: string): Promise<boolean> {
    const response = await runHerdr(["tab", "list"]);
    const tabs = findArrayField(response, "tabs") ?? [];
    return tabs.some((tab) => isRecord(tab) && tab.tab_id === tabId);
  }

  async closeTab(tabId: string): Promise<void> {
    await runHerdr(["tab", "close", tabId]);
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
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

function requireString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") {
    throw new Error(`Invalid fixture artifact: missing ${field}`);
  }
  return value[field];
}

function inferWorkspaceId(): string {
  const paneId = process.env.HERDR_PANE_ID;
  const separator = paneId?.indexOf(":") ?? -1;
  if (!paneId || separator <= 0) {
    throw new Error("Native Herdr control unavailable: HERDR_PANE_ID is missing");
  }
  return paneId.slice(0, separator);
}

export async function createNativeFixtureRuntime(options: NativeRuntimeOptions): Promise<FixtureRuntime> {
  const herdrCli = new HerdrCliClient();
  const herdr = options.herdr ?? herdrCli;
  const processHost = options.processHost ?? herdrCli;
  const stateRoot =
    options.stateRoot ?? process.env.PI_LEAD_STATE_DIR ?? join(homedir(), ".local", "state", "pi-lead");
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const runs = new Map<string, RunState>();

  return {
    async launch(request: FixtureLaunchRequest, signal?: AbortSignal): Promise<OwnedWorker> {
      if (
        request.focus !== false ||
        request.allowedHosts.length !== 0 ||
        request.allowWebSockets !== false ||
        request.hostMounts.length !== 0 ||
        request.inheritHostEnvironment !== false
      ) {
        throw new Error("Fixture launch policy is not isolated");
      }

      const workerId = randomUUID();
      const runKey = createHash("sha256")
        .update(`${request.taskId}\0${request.assignmentId}\0${workerId}`)
        .digest("hex");
      const directory = join(stateRoot, runKey);
      let diagnosticsRetained = false;
      let launcherMayBeRunning = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        signal?.throwIfAborted();
        const workspaceId = options.workspaceId ?? inferWorkspaceId();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const policy = createIsolatedFixturePolicy({
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          workerId,
        });
        await writeFile(join(directory, "heartbeat"), new Date().toISOString(), {
          encoding: "utf8",
          mode: 0o600,
        });

        const tab = await herdr.createBackgroundTab({
          workspaceId,
          cwd: options.cwd,
          label: request.tabLabel,
          focus: false,
        });
        diagnosticsRetained = true;
        await writeJsonAtomically(join(directory, "launch.json"), {
          schemaVersion: 1,
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          workerId,
          tabId: tab.tabId,
          paneId: tab.paneId,
          policy,
          fixtureHoldMs: options.fixtureHoldMs ?? 0,
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
        const resources = await waitForJson(join(directory, "resources.json"), {
          pollIntervalMs,
          signal,
          timeoutMs: 180_000,
        });
        const resourceWorkerId = requireString(resources, "workerId");
        if (resourceWorkerId !== workerId) throw new Error("Launcher returned the wrong worker identity");
        const worker: OwnedWorker = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          workerId,
          vmId: requireString(resources, "vmId"),
          tabId: tab.tabId,
          paneId: tab.paneId,
        };
        const identity = { ...worker, piSessionId: `fixture:${workerId}` };
        await options.onWorkerOwned?.({ identity, stateDirectory: directory, phase: "BUILD" });
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
        throw new FixtureLaunchFailure(
          error instanceof Error ? error.message : String(error),
          diagnosticsRetained,
          vmTerminated,
        );
      }
    },

    async waitForResult(worker: OwnedWorker, signal?: AbortSignal): Promise<FixtureResult> {
      const run = runs.get(worker.vmId);
      if (!run || run.worker.workerId !== worker.workerId) throw new Error("Worker is not owned by this runtime");
      while (true) {
        if (!(await herdr.tabExists(worker.tabId))) {
          await writeJsonAtomically(join(run.directory, "cancel.json"), { reason: "TERMINAL_LOST" });
          throw new Error("Worker terminal was closed");
        }
        const error = await readJsonIfPresent(join(run.directory, "error.json"));
        if (error !== undefined) throw new Error(requireString(error, "message"));
        const result = await readJsonIfPresent(join(run.directory, "result.json"));
        if (result !== undefined) {
          const parsed = {
            taskId: requireString(result, "taskId"),
            assignmentId: requireString(result, "assignmentId"),
            workerId: requireString(result, "workerId"),
            vmId: requireString(result, "vmId"),
            tabId: requireString(result, "tabId"),
            paneId: requireString(result, "paneId"),
            output: requireString(result, "output"),
          };
          await options.onWorkerResult?.({ ...worker, piSessionId: `fixture:${worker.workerId}` });
          return parsed;
        }
        await wait(pollIntervalMs, signal);
      }
    },

    async collectResult(result: FixtureResult): Promise<CollectedFixtureResult> {
      const run = runs.get(result.vmId);
      if (!run) throw new Error("Cannot collect a result for an unowned VM");
      const serialized = await readFile(join(run.directory, "result.json"), "utf8");
      return {
        output: result.output,
        artifactId: createHash("sha256").update(serialized).digest("hex"),
      };
    },

    async terminate(worker: OwnedWorker): Promise<{ vmId: string; terminated: boolean }> {
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
        vmId: requireString(termination, "vmId"),
        terminated: isRecord(termination) && termination.terminated === true,
      };
    },

    async closeSuccessfulTab(tabId: string): Promise<void> {
      await herdr.closeTab(tabId);
      const run = [...runs.values()].find((candidate) => candidate.worker.tabId === tabId);
      if (run) await options.onWorkerCleaned?.({ ...run.worker, piSessionId: `fixture:${run.worker.workerId}` });
    },
  };
}
