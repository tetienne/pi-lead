import { spawn } from "node:child_process";
import { appendFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VM, type VMOptions } from "@earendil-works/gondolin";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  createChatGptMediation,
  type ChatGptCredential,
} from "./chatgpt-policy.ts";
import { MAX_CHATGPT_TASK_CHARS } from "./chatgpt-input.ts";
import { observeProcessExit } from "./process-observation.ts";
import type { NativePiEvent, ProviderFailure } from "./chatgpt-task.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";

type ResolvedAuthLike = {
  auth: { apiKey?: string };
  source?: string;
};

export type ParsedPiJsonResult =
  | {
      status: "answered";
      output: string;
      stopReason: string;
      nativeEvents: NativePiEvent[];
    }
  | {
      status: "failed";
      failure: ProviderFailure;
      detail: string;
      nativeEvents: NativePiEvent[];
    };

export interface ChatGptCredentialSource {
  assertModelAvailable(modelId: string): void;
  getCredential(signal?: AbortSignal): Promise<ChatGptCredential>;
}

export class ProviderSetupError extends Error {
  readonly reason: "MODEL_UNAVAILABLE" | "REFRESH_FAILED";

  constructor(reason: "MODEL_UNAVAILABLE" | "REFRESH_FAILED", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderSetupError";
    this.reason = reason;
  }
}

function requireString(value: unknown, field: string, maxLength = 16_384): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].length > maxLength) {
    throw new Error(`Invalid ChatGPT launch record: ${field}`);
  }
  return value[field];
}

function parseJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("invalid bearer token shape");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
}

export function extractChatGptCredential(auth: ResolvedAuthLike): ChatGptCredential {
  const accessToken = auth.auth.apiKey;
  if (!accessToken) throw new Error("ChatGPT OAuth bearer token is unavailable");
  const payload = parseJwtPayload(accessToken);
  if (!isRecord(payload)) throw new Error("ChatGPT OAuth token payload is invalid");
  const claim = payload["https://api.openai.com/auth"];
  if (!isRecord(claim) || typeof claim.chatgpt_account_id !== "string") {
    throw new Error("ChatGPT OAuth account identity is unavailable");
  }
  return { accessToken, accountId: claim.chatgpt_account_id };
}

function classifyProviderFailure(message: string): ProviderFailure | undefined {
  if (/usage limit|quota|available balance|out of budget|billing|insufficient/i.test(message)) {
    return "QUOTA_EXHAUSTED";
  }
  if (/credential refresh|login expired|oauth|invalid_grant|authentication/i.test(message)) {
    return "REFRESH_FAILED";
  }
  if (/model.+(?:unavailable|not found|unknown|does not exist)|no models available/i.test(message)) {
    return "MODEL_UNAVAILABLE";
  }
  return undefined;
}

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((content): content is Record<string, unknown> => isRecord(content))
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text as string)
    .join("");
}

export function parsePiJsonResult(stdout: string, expectedSessionId: string): ParsedPiJsonResult {
  if (Buffer.byteLength(stdout, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Native Pi event stream exceeded 4 MiB");
  }
  let sessionMatches = false;
  const nativeEvents: NativePiEvent[] = [];
  let assistant: Record<string, unknown> | undefined;
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(rawLine) as unknown;
    } catch {
      throw new Error("Native Pi emitted a non-JSON lifecycle record");
    }
    if (!isRecord(event) || typeof event.type !== "string") continue;
    if (event.type === "session") {
      sessionMatches = event.id === expectedSessionId;
    } else if (event.type === "agent_start" || event.type === "agent_end") {
      if (!nativeEvents.includes(event.type)) nativeEvents.push(event.type);
    } else if (event.type === "agent_settled") {
      if (!nativeEvents.includes("agent_settled")) nativeEvents.push("agent_settled");
    } else if (event.type === "message_end") {
      if (!nativeEvents.includes("message_end")) nativeEvents.push("message_end");
      if (isRecord(event.message) && event.message.role === "assistant") assistant = event.message;
    }
  }
  if (!sessionMatches) throw new Error("Native Pi session identity did not match the assignment");
  if (!assistant) throw new Error("Native Pi emitted no authoritative assistant message");
  const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : "error";
  const output = assistantText(assistant);
  if (stopReason === "error" || stopReason === "aborted") {
    const detail =
      typeof assistant.errorMessage === "string"
        ? assistant.errorMessage
        : `ChatGPT request stopped with ${stopReason}`;
    const failure = classifyProviderFailure(detail);
    if (!failure) throw new Error(detail);
    return {
      status: "failed",
      failure,
      detail,
      nativeEvents,
    };
  }
  return { status: "answered", output, stopReason, nativeEvents };
}

async function assertGuestStorageContainsNoHostCredential(
  vm: VM,
  redact: (value: string) => string,
): Promise<void> {
  const pending = ["/tmp/pi-agent", "/tmp/pi-sessions", "/tmp/pi-home", "/workspace"];
  let filesRead = 0;
  let bytesRead = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let children: string[];
    try {
      children = await vm.fs.listDir(current);
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = join(current, child);
      const metadata = await vm.fs.stat(childPath);
      if (metadata.isDirectory()) {
        pending.push(childPath);
        continue;
      }
      if (!metadata.isFile()) continue;
      filesRead++;
      bytesRead += metadata.size;
      if (filesRead > 200 || bytesRead > 4 * 1024 * 1024) {
        throw new Error("Guest-visible storage exceeded the credential-audit bound");
      }
      const contents = await vm.fs.readFile(childPath);
      const text = contents.toString("utf8");
      if (redact(text) !== text) {
        throw new Error(`Host credentials appeared in guest-visible storage: ${childPath}`);
      }
    }
  }
}

type NativeModelRuntime = Pick<
  ModelRuntime,
  "getAuth" | "getModel" | "isUsingSubscription"
>;

export type NativeModelRuntimeFactory = (options: {
  allowModelNetwork: false;
  refreshOnCreate: boolean;
  signal?: AbortSignal;
}) => Promise<NativeModelRuntime>;

class NativePiCredentialSource implements ChatGptCredentialSource {
  readonly #runtime: NativeModelRuntime;

  constructor(runtime: NativeModelRuntime) {
    this.#runtime = runtime;
  }

  assertModelAvailable(modelId: string): void {
    if (!this.#runtime.getModel("openai-codex", modelId)) {
      throw new ProviderSetupError(
        "MODEL_UNAVAILABLE",
        `The approved ChatGPT model ${modelId} is unavailable in the pinned Pi catalog`,
      );
    }
  }

  async getCredential(signal?: AbortSignal): Promise<ChatGptCredential> {
    try {
      const auth = await this.#runtime.getAuth("openai-codex", {
        minOAuthValidityMs: 5 * 60_000,
        signal,
      });
      if (!auth) throw new Error("run `pi auth login --provider openai-codex` on the host");
      return extractChatGptCredential(auth);
    } catch (error) {
      if (error instanceof ProviderSetupError) throw error;
      throw new ProviderSetupError(
        "REFRESH_FAILED",
        `ChatGPT subscription authentication is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

export async function createNativePiCredentialSource(
  signal?: AbortSignal,
  createRuntime: NativeModelRuntimeFactory = (options) => ModelRuntime.create(options),
): Promise<ChatGptCredentialSource> {
  const runtime = await createRuntime({
    allowModelNetwork: false,
    refreshOnCreate: true,
    signal,
  });
  if (!runtime.isUsingSubscription("openai-codex")) {
    throw new ProviderSetupError(
      "REFRESH_FAILED",
      "The native openai-codex provider is not configured for subscription authentication",
    );
  }
  return new NativePiCredentialSource(runtime);
}

type LaunchRecord = {
  taskId: string;
  assignmentId: string;
  question: string;
  workerId: string;
  piSessionId: string;
  tabId: string;
  paneId: string;
  modelId: string;
  controllerHeartbeatTimeoutMs: number;
};

function parseLaunchRecord(value: unknown): LaunchRecord {
  if (!isRecord(value) || !isRecord(value.policy)) throw new Error("Invalid ChatGPT launch record");
  const policy = value.policy;
  if (
    policy.provider !== "openai-codex" ||
    policy.transport !== "sse" ||
    policy.cacheWarming !== "off" ||
    policy.allowWebSockets !== false ||
    policy.inheritHostEnvironment !== false ||
    !Array.isArray(policy.allowedHosts) ||
    policy.allowedHosts.length !== 1 ||
    policy.allowedHosts[0] !== "chatgpt.com" ||
    !Array.isArray(policy.hostMounts) ||
    policy.hostMounts.length !== 0
  ) {
    throw new Error("ChatGPT launch policy is incomplete");
  }
  const question = requireString(value, "question", MAX_CHATGPT_TASK_CHARS);
  if (!question.trim()) throw new Error("ChatGPT question is empty");
  const timeout = value.controllerHeartbeatTimeoutMs;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1_000) {
    throw new Error("Invalid controller heartbeat timeout");
  }
  return {
    taskId: requireString(value, "taskId", 160),
    assignmentId: requireString(value, "assignmentId", 160),
    question,
    workerId: requireString(value, "workerId", 160),
    piSessionId: requireString(value, "piSessionId", 160),
    tabId: requireString(value, "tabId", 160),
    paneId: requireString(value, "paneId", 160),
    modelId: requireString(value, "modelId", 160),
    controllerHeartbeatTimeoutMs: timeout,
  };
}

function resolvePiBundleDirectory(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(entry), "bundle");
}

async function stagePiBundle(vm: VM, bundleDirectory: string): Promise<void> {
  await vm.fs.mkdir("/opt/pi", { recursive: true, mode: 0o700 });
  const packageRoot = dirname(dirname(bundleDirectory));
  const archive = spawn(
    "tar",
    [
      "-C",
      packageRoot,
      "-cf",
      "-",
      "package.json",
      "dist/bundle",
      "dist/modes/interactive/theme",
      "node_modules/@earendil-works/chord",
      "node_modules/typebox",
      "node_modules/undici",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!archive.stdout) throw new Error("Failed to open Pi bundle archive stream");
  let archiveError = "";
  archive.stderr?.setEncoding("utf8");
  archive.stderr?.on("data", (chunk: string) => {
    archiveError += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    archive.once("error", reject);
    archive.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Pi bundle staging failed: ${archiveError.trim() || `tar exited ${code}`}`));
    });
  });
  await Promise.all([vm.fs.writeFile("/tmp/pi-bundle.tar", archive.stdout), exited]);
  const extracted = await vm.exec([
    "/bin/tar",
    "-xf",
    "/tmp/pi-bundle.tar",
    "-C",
    "/opt/pi",
  ]);
  if (!extracted.ok) throw new Error(`Pi bundle extraction failed: ${extracted.stderr}`);
}

function createFakeSafeEnvironment(
  launch: LaunchRecord,
  guestSecrets: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    HOME: "/tmp/pi-home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
    PI_PACKAGE_DIR: "/opt/pi",
    PI_LEAD_TASK_ID: launch.taskId,
    PI_LEAD_ASSIGNMENT_ID: launch.assignmentId,
    PI_LEAD_WORKER_ID: launch.workerId,
    PI_LEAD_PI_SESSION_ID: launch.piSessionId,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    ...guestSecrets,
  };
}

async function applyGuestCaEnvironment(vm: VM, environment: Record<string, string>): Promise<string> {
  const candidates = [
    "/run/gondolin/ca-certificates.crt",
    "/etc/gondolin/mitm/ca.crt",
    "/etc/ssl/certs/ca-certificates.crt",
  ];
  for (const candidate of candidates) {
    try {
      await vm.fs.access(candidate);
      environment.NODE_EXTRA_CA_CERTS = candidate;
      environment.SSL_CERT_FILE = candidate;
      return candidate;
    } catch {
      // Try the next image-specific CA location.
    }
  }
  throw new Error("Gondolin guest CA bundle is unavailable");
}

function identity(launch: LaunchRecord, vmId: string) {
  return {
    taskId: launch.taskId,
    assignmentId: launch.assignmentId,
    workerId: launch.workerId,
    vmId,
    tabId: launch.tabId,
    paneId: launch.paneId,
    piSessionId: launch.piSessionId,
  };
}

export type RunChatGptWorkerHostOptions = {
  stateDirectory: string;
  credentialSource?: ChatGptCredentialSource;
  debugLog?: (message: string) => void;
  liveOutput?: (message: string) => void;
  upstreamFetch?: VMOptions["fetch"];
  piBundleDirectory?: string;
};

export async function runChatGptWorkerHost(options: RunChatGptWorkerHostOptions): Promise<void> {
  const launch = parseLaunchRecord(
    JSON.parse(await readFile(join(options.stateDirectory, "launch.json"), "utf8")) as unknown,
  );
  const runtimeLogPath = join(options.stateDirectory, "runtime.log");
  const abortController = new AbortController();
  const abortForSignal = () => abortController.abort(new DOMException("Terminal closed", "AbortError"));
  process.once("SIGHUP", abortForSignal);
  process.once("SIGINT", abortForSignal);
  process.once("SIGTERM", abortForSignal);
  let checkingHeartbeat = false;
  const watchdog = setInterval(() => {
    if (checkingHeartbeat || abortController.signal.aborted) return;
    checkingHeartbeat = true;
    void (async () => {
      try {
        if (await readJsonIfPresent(join(options.stateDirectory, "cancel.json"))) {
          abortController.abort(new DOMException("Controller requested stop", "AbortError"));
          return;
        }
        const heartbeat = await stat(join(options.stateDirectory, "heartbeat"));
        if (Date.now() - heartbeat.mtimeMs > launch.controllerHeartbeatTimeoutMs) {
          abortController.abort(new DOMException("Controller heartbeat lost", "TimeoutError"));
        }
      } catch {
        abortController.abort(new DOMException("Controller heartbeat unavailable", "TimeoutError"));
      } finally {
        checkingHeartbeat = false;
      }
    })();
  }, 250);
  watchdog.unref();

  let vm: VM | undefined;
  let vmId = "unstarted";
  let hostPid: number | null = null;
  let terminated = false;
  let resourcesStarted = false;
  try {
    const credentialSource =
      options.credentialSource ?? (await createNativePiCredentialSource(abortController.signal));
    credentialSource.assertModelAvailable(launch.modelId);
    const initialCredential = await credentialSource.getCredential(abortController.signal);
    const mediation = createChatGptMediation({
      initialCredential,
      placeholderNonce: launch.workerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128),
      refreshCredential: (signal) => credentialSource.getCredential(signal),
    });
    const guestEnvironment = createFakeSafeEnvironment(launch, mediation.guestEnvironment);
    vm = await VM.create({
      allowWebSockets: false,
      autoStart: true,
      debugLog: options.debugLog,
      env: guestEnvironment,
      fetch: options.upstreamFetch,
      httpHooks: mediation.httpHooks,
      sessionLabel: `pi-lead:${launch.workerId}`,
      startTimeoutMs: 30_000,
      // An empty VFS grant mounts only Gondolin's generated read-only MITM CA;
      // it does not expose a host path to the guest.
      vfs: { mounts: {} },
    });
    vmId = vm.id;
    hostPid = vm.getHostPid();
    const guestCaPath = await applyGuestCaEnvironment(vm, guestEnvironment);
    await writeJsonAtomically(join(options.stateDirectory, "resources.json"), {
      workerId: launch.workerId,
      vmId,
    });
    resourcesStarted = true;
    abortController.signal.throwIfAborted();
    await appendFile(runtimeLogPath, "PI Lead: staging pinned Pi worker\n", { mode: 0o600 });
    options.debugLog?.(`using guest CA bundle ${guestCaPath}`);
    await stagePiBundle(vm, options.piBundleDirectory ?? resolvePiBundleDirectory());
    abortController.signal.throwIfAborted();
    await vm.fs.mkdir("/workspace", { recursive: true, mode: 0o700 });
    await vm.fs.mkdir("/tmp/pi-agent", { recursive: true, mode: 0o700 });
    await vm.fs.mkdir("/tmp/pi-home", { recursive: true, mode: 0o700 });
    await vm.fs.writeFile(
      "/tmp/pi-agent/models.json",
      `${JSON.stringify(mediation.providerOverlay)}\n`,
      { encoding: "utf8" },
    );
    await vm.fs.writeFile(
      "/tmp/pi-agent/settings.json",
      `${JSON.stringify({
        ...mediation.settings,
        defaultProjectTrust: "never",
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      })}\n`,
      { encoding: "utf8" },
    );
    await appendFile(runtimeLogPath, "PI Lead: native Pi agent starting with SSE\n", { mode: 0o600 });
    const processInVm = vm.exec(
      [
        "/usr/bin/node",
        "/opt/pi/dist/bundle/cli.js",
        "--mode",
        "json",
        "--no-session",
        "--session-id",
        launch.piSessionId,
        "--provider",
        "openai-codex",
        "--model",
        launch.modelId,
        "--thinking",
        "off",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--offline",
        "--system-prompt",
        "Answer the bounded question from the supplied project context. Do not use tools. Be concise.",
        "--",
        launch.question,
      ],
      {
        cwd: "/workspace",
        env: guestEnvironment,
        pty: true,
        signal: abortController.signal,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    hostPid ??= vm.getHostPid();
    let stdout = "";
    let stderr = "";
    const visibleBuffers = { stdout: "", stderr: "" };
    let streamedCredentialLeak = false;
    const appendVisibleLines = async (
      stream: "stdout" | "stderr",
      text: string,
      flush = false,
    ): Promise<void> => {
      visibleBuffers[stream] += text;
      while (true) {
        const newline = visibleBuffers[stream].indexOf("\n");
        if (newline < 0 && !flush) return;
        if (newline < 0 && visibleBuffers[stream].length === 0) return;
        const line =
          newline < 0
            ? visibleBuffers[stream]
            : visibleBuffers[stream].slice(0, newline + 1);
        visibleBuffers[stream] = newline < 0 ? "" : visibleBuffers[stream].slice(newline + 1);
        if (mediation.redactHostSecrets(line) !== line) {
          if (!streamedCredentialLeak) {
            const warning =
              "PI Lead BLOCKED: provider reflected host credentials; live output withheld\n";
            await appendFile(
              runtimeLogPath,
              warning,
              { encoding: "utf8", mode: 0o600 },
            );
            options.liveOutput?.(warning);
          }
          streamedCredentialLeak = true;
        } else {
          await appendFile(runtimeLogPath, line, { encoding: "utf8", mode: 0o600 });
          options.liveOutput?.(line);
        }
      }
    };
    for await (const chunk of processInVm.output()) {
      if (chunk.stream === "stdout") stdout += chunk.text;
      else stderr += chunk.text;
      await appendVisibleLines(chunk.stream, chunk.text);
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > 4 * 1024 * 1024) {
        abortController.abort(new Error("Native Pi output exceeded 4 MiB"));
        throw new Error("Native Pi output exceeded 4 MiB");
      }
    }
    await appendVisibleLines("stdout", "", true);
    await appendVisibleLines("stderr", "", true);
    const processResult = await processInVm;
    const redactedStdout = mediation.redactHostSecrets(stdout);
    const redactedStderr = mediation.redactHostSecrets(stderr);
    const leaked =
      streamedCredentialLeak || redactedStdout !== stdout || redactedStderr !== stderr;
    await assertGuestStorageContainsNoHostCredential(vm, (value) =>
      mediation.redactHostSecrets(value),
    );
    if (leaked) throw new Error("Provider response attempted to expose host credentials");
    let parsed: ParsedPiJsonResult;
    try {
      parsed = parsePiJsonResult(stdout, launch.piSessionId);
    } catch (error) {
      const policyRejection = mediation.getLastPolicyRejection();
      const detail = `${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr.trim()}` : ""}${policyRejection ? `; request policy: ${policyRejection}` : ""}`;
      const failure = classifyProviderFailure(detail);
      if (!processResult.ok && failure) {
        parsed = { status: "failed", failure, detail, nativeEvents: [] };
      } else {
        throw new Error(detail);
      }
    }
    await writeJsonAtomically(join(options.stateDirectory, "result.json"), {
      ...identity(launch, vmId),
      ...parsed,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!resourcesStarted) {
      await writeJsonAtomically(join(options.stateDirectory, "launch-error.json"), {
        reason: error instanceof ProviderSetupError ? error.reason : "NATIVE_CONTROL_UNAVAILABLE",
        detail,
      });
    } else {
      await writeJsonAtomically(join(options.stateDirectory, "error.json"), { detail });
    }
    await appendFile(runtimeLogPath, `PI Lead worker BLOCKED: ${detail}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } finally {
    clearInterval(watchdog);
    process.off("SIGHUP", abortForSignal);
    process.off("SIGINT", abortForSignal);
    process.off("SIGTERM", abortForSignal);
    if (vm) {
      try {
        hostPid ??= vm.getHostPid();
        await vm.close();
        terminated = await observeProcessExit(hostPid, 5_000);
      } catch {
        terminated = false;
      }
    } else {
      terminated = true;
    }
    await writeJsonAtomically(join(options.stateDirectory, "termination.json"), { vmId, terminated });
  }
}
