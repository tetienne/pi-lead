import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ChatGptLaunchFailure,
  type AnsweredChatGptResult,
  type ChatGptLaunchRequest,
  type ChatGptTaskRuntime,
  type ChatGptWorker,
  type ChatGptWorkerResult,
  type FailedChatGptResult,
  type NativePiEvent,
  type ProviderFailure,
} from "./chatgpt-task.ts";
import { MAX_CHATGPT_TASK_CHARS } from "./chatgpt-input.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { EffectivePiRoute, PiReasoningLevel, WorkerProvider } from "./model-reasoning-routing.ts";
import { parseEffectivePiRoute } from "./effective-route-observation.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";
import type { NativeWorkerCleanupObserver, NativeWorkerObserver, NativeWorkerResultObserver } from "./native-worker-observation.ts";

const execFileAsync = promisify(execFile);
const NATIVE_EVENTS = new Set<NativePiEvent>([
  "agent_start",
  "message_end",
  "agent_end",
  "agent_settled",
]);
const PROVIDER_FAILURES = new Set<ProviderFailure>([
  "QUOTA_EXHAUSTED",
  "REFRESH_FAILED",
  "MODEL_UNAVAILABLE",
]);

export interface ChatGptProcessHost {
  start(request: { paneId: string; stateDirectory: string }): Promise<void>;
}

type NativeChatGptRuntimeOptions = {
  cwd: string;
  modelId?: string;
  reasoning?: PiReasoningLevel;
  onWorkerSpawn?(effective: EffectivePiRoute): void;
  onWorkerOwned?: NativeWorkerObserver;
  onWorkerResult?: NativeWorkerResultObserver;
  onWorkerCleaned?: NativeWorkerCleanupObserver;
  workspaceId?: string;
  stateRoot?: string;
  herdr?: HerdrClient;
  processHost?: ChatGptProcessHost;
  pollIntervalMs?: number;
  workerProfile?: {
    provider: WorkerProvider;
    allowedHost: string;
    launcherPath: string;
    requireChatGptProtocol: boolean;
  };
  workerPhase?: "DISCOVER" | "DEBUG" | "BUILD" | "VERIFY";
};

type RunState = {
  directory: string;
  heartbeat: ReturnType<typeof setInterval>;
  worker: ChatGptWorker;
};

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

class NativeChatGptCliClient implements HerdrClient, ChatGptProcessHost {
  readonly #launcherPath: string;

  constructor(launcher = "./chatgpt-launcher.ts") {
    this.#launcherPath = fileURLToPath(new URL(launcher, import.meta.url));
  }

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
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
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

async function waitForLaunchArtifact(
  directory: string,
  options: { pollIntervalMs: number; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const failure = await readJsonIfPresent(join(directory, "launch-error.json"));
    if (failure !== undefined) {
      const reason = requireString(failure, "reason");
      const mappedReason =
        reason === "MODEL_UNAVAILABLE" || reason === "REFRESH_FAILED"
          ? reason
          : "NATIVE_CONTROL_UNAVAILABLE";
      throw new ChatGptLaunchFailure(mappedReason, requireString(failure, "detail"), true, true);
    }
    const resources = await readJsonIfPresent(join(directory, "resources.json"));
    if (resources !== undefined) return resources;
    await wait(options.pollIntervalMs, options.signal);
  }
  throw new DOMException("Timed out waiting for ChatGPT worker resources", "TimeoutError");
}

function requireString(value: unknown, field: string, maxLength = 1024 * 1024): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].length > maxLength) {
    throw new Error(`Invalid ChatGPT artifact: ${field}`);
  }
  return value[field];
}

function parseNativeEvents(value: unknown): NativePiEvent[] {
  if (!isRecord(value) || !Array.isArray(value.nativeEvents)) {
    throw new Error("Invalid ChatGPT artifact: nativeEvents");
  }
  return value.nativeEvents.map((event) => {
    if (typeof event !== "string" || !NATIVE_EVENTS.has(event as NativePiEvent)) {
      throw new Error("Invalid ChatGPT artifact: native event");
    }
    return event as NativePiEvent;
  });
}

function parseResult(value: unknown): ChatGptWorkerResult {
  if (!isRecord(value)) throw new Error("Invalid ChatGPT result");
  const identity = {
    taskId: requireString(value, "taskId", 160),
    assignmentId: requireString(value, "assignmentId", 160),
    workerId: requireString(value, "workerId", 160),
    vmId: requireString(value, "vmId", 160),
    tabId: requireString(value, "tabId", 160),
    paneId: requireString(value, "paneId", 160),
    piSessionId: requireString(value, "piSessionId", 160),
  };
  const nativeEvents = parseNativeEvents(value);
  if (value.status === "answered") {
    return {
      ...identity,
      status: "answered",
      output: requireString(value, "output"),
      nativeEvents,
      stopReason: requireString(value, "stopReason", 80),
    } satisfies AnsweredChatGptResult;
  }
  if (value.status === "failed") {
    const failure = requireString(value, "failure", 80);
    if (!PROVIDER_FAILURES.has(failure as ProviderFailure)) {
      throw new Error("Invalid ChatGPT artifact: provider failure");
    }
    return {
      ...identity,
      status: "failed",
      failure: failure as ProviderFailure,
      detail: requireString(value, "detail", 16_384),
      nativeEvents,
    } satisfies FailedChatGptResult;
  }
  throw new Error("Invalid ChatGPT artifact: status");
}

export async function createNativeChatGptRuntime(
  options: NativeChatGptRuntimeOptions,
): Promise<ChatGptTaskRuntime> {
  const profile = options.workerProfile ?? {
    provider: "openai-codex",
    allowedHost: "chatgpt.com",
    launcherPath: "./chatgpt-launcher.ts",
    requireChatGptProtocol: true,
  };
  const cli = new NativeChatGptCliClient(profile.launcherPath);
  const herdr = options.herdr ?? cli;
  const processHost = options.processHost ?? cli;
  const stateRoot =
    options.stateRoot ?? process.env.PI_LEAD_STATE_DIR ?? join(homedir(), ".local", "state", "pi-lead");
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const modelId = options.modelId ?? "gpt-5.6-luna";
  const reasoning = options.reasoning ?? "off";
  const runs = new Map<string, RunState>();

  return {
    async launch(request: ChatGptLaunchRequest, signal?: AbortSignal): Promise<ChatGptWorker> {
      const profileRequest = request as unknown as {
        provider: string;
        transport?: string;
        cacheWarming?: string;
        allowedHosts: readonly string[];
      };
      if (
        (profile.requireChatGptProtocol
          ? profileRequest.provider !== profile.provider ||
            profileRequest.transport !== "sse" ||
            profileRequest.cacheWarming !== "off" ||
            profileRequest.allowedHosts.length !== 1 ||
            profileRequest.allowedHosts[0] !== profile.allowedHost
          : profileRequest.provider !== profile.provider ||
            profileRequest.allowedHosts.length !== 1 ||
            profileRequest.allowedHosts[0] !== profile.allowedHost) ||
        request.allowWebSockets !== false ||
        request.focus !== false ||
        request.hostMounts.length !== 0 ||
        request.inheritHostEnvironment !== false ||
        request.question.trim().length === 0 ||
        request.question.length > MAX_CHATGPT_TASK_CHARS
      ) {
        throw new Error("ChatGPT launch policy is not the approved read-only profile");
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
        const workspaceId = options.workspaceId ?? inferWorkspaceId();
        await mkdir(directory, { recursive: true, mode: 0o700 });
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
          question: request.question,
          workerId,
          piSessionId,
          tabId: tab.tabId,
          paneId: tab.paneId,
          modelId,
          reasoning,
          controllerHeartbeatTimeoutMs: 5_000,
          controllerAdmissionRequired: true,
          policy: {
            provider: profileRequest.provider,
            ...(profile.requireChatGptProtocol ? { transport: request.transport, cacheWarming: request.cacheWarming } : {}),
            allowedHosts: profileRequest.allowedHosts,
            allowWebSockets: request.allowWebSockets,
            hostMounts: request.hostMounts,
            inheritHostEnvironment: request.inheritHostEnvironment,
          },
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
        const worker: ChatGptWorker = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          workerId,
          vmId: requireString(resources, "vmId", 160),
          tabId: tab.tabId,
          paneId: tab.paneId,
          piSessionId,
        };
        const effectiveRoute = parseEffectivePiRoute(resources, profile.provider, "worker");
        if (options.onWorkerSpawn) options.onWorkerSpawn(effectiveRoute);
        if (options.onWorkerOwned) {
          await options.onWorkerOwned({ effectiveRoute, identity: worker, stateDirectory: directory, phase: options.workerPhase ?? "DISCOVER" });
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
        if (error instanceof ChatGptLaunchFailure) {
          throw new ChatGptLaunchFailure(
            error.reason,
            error.message,
            diagnosticsRetained || error.diagnosticsRetained,
            vmTerminated && error.vmTerminated,
          );
        }
        throw new ChatGptLaunchFailure(
          "NATIVE_CONTROL_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
          diagnosticsRetained,
          vmTerminated,
        );
      }
    },

    async waitForResult(worker: ChatGptWorker, signal?: AbortSignal): Promise<ChatGptWorkerResult> {
      const run = runs.get(worker.vmId);
      if (!run || run.worker.workerId !== worker.workerId) throw new Error("Worker is not owned by this runtime");
      while (true) {
        if (!(await herdr.tabExists(worker.tabId))) {
          await writeJsonAtomically(join(run.directory, "cancel.json"), { reason: "TERMINAL_LOST" });
          throw new Error("Worker terminal was closed");
        }
        const error = await readJsonIfPresent(join(run.directory, "error.json"));
        if (error !== undefined) throw new Error(requireString(error, "detail", 16_384));
        const result = await readJsonIfPresent(join(run.directory, "result.json"));
        if (result !== undefined) {
          const parsed = parseResult(result);
          await options.onWorkerResult?.(worker);
          return parsed;
        }
        await wait(pollIntervalMs, signal);
      }
    },

    async collectResult(result: AnsweredChatGptResult) {
      const run = runs.get(result.vmId);
      if (!run) throw new Error("Cannot collect a result for an unowned VM");
      const serialized = await readFile(join(run.directory, "result.json"), "utf8");
      return {
        output: result.output,
        artifactId: createHash("sha256").update(serialized).digest("hex"),
      };
    },

    async terminate(worker: ChatGptWorker): Promise<{ vmId: string; terminated: boolean }> {
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
