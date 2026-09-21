import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { VM, type VMOptions } from "@earendil-works/gondolin";

import {
  applyGuestCaEnvironment,
  parsePiJsonResult,
  stagePiBundle,
} from "./chatgpt-worker-host.ts";
import { OPENCODE_GO_API_KEY_ENV, classifyOpenCodeGoFailure, createOpenCodeGoMediation } from "./opencode-go-policy.ts";
import { observeProcessExit } from "./process-observation.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";

type Launch = {
  taskId: string; assignmentId: string; question: string; workerId: string; piSessionId: string;
  tabId: string; paneId: string; modelId: string; controllerHeartbeatTimeoutMs: number;
};

function stringField(value: unknown, name: string, max = 16_384): string {
  if (!isRecord(value) || typeof value[name] !== "string" || value[name].length > max) {
    throw new Error(`Invalid OpenCode Go launch record: ${name}`);
  }
  return value[name];
}

function parseLaunch(value: unknown): Launch {
  if (!isRecord(value) || !isRecord(value.policy)) throw new Error("Invalid OpenCode Go launch record");
  const policy = value.policy;
  if (
    policy.provider !== "opencode-go" || policy.allowWebSockets !== false ||
    policy.inheritHostEnvironment !== false || !Array.isArray(policy.allowedHosts) ||
    policy.allowedHosts.length !== 1 || policy.allowedHosts[0] !== "opencode.ai" ||
    !Array.isArray(policy.hostMounts) || policy.hostMounts.length !== 0
  ) throw new Error("OpenCode Go launch policy is incomplete");
  const timeout = value.controllerHeartbeatTimeoutMs;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1_000) {
    throw new Error("Invalid controller heartbeat timeout");
  }
  return {
    taskId: stringField(value, "taskId", 160), assignmentId: stringField(value, "assignmentId", 160),
    question: stringField(value, "question"), workerId: stringField(value, "workerId", 160),
    piSessionId: stringField(value, "piSessionId", 160), tabId: stringField(value, "tabId", 160),
    paneId: stringField(value, "paneId", 160), modelId: stringField(value, "modelId", 160),
    controllerHeartbeatTimeoutMs: timeout,
  };
}

function bundleDirectory(): string {
  return join(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/", import.meta.url).pathname);
}

function environment(launch: Launch, secrets: Readonly<Record<string, string>>): Record<string, string> {
  return {
    HOME: "/tmp/pi-home", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
    PI_PACKAGE_DIR: "/opt/pi", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_LEAD_TASK_ID: launch.taskId, PI_LEAD_ASSIGNMENT_ID: launch.assignmentId,
    PI_LEAD_WORKER_ID: launch.workerId, PI_LEAD_PI_SESSION_ID: launch.piSessionId,
    ...secrets,
  };
}

export async function runOpenCodeGoWorkerHost(options: {
  stateDirectory: string;
  apiKey?: string;
  /** Set only after the account's “Use balance” option is confirmed disabled. */
  overageConfirmedDisabled?: boolean;
  upstreamFetch?: VMOptions["fetch"];
  piBundleDirectory?: string;
  liveOutput?: (line: string) => void;
}): Promise<void> {
  const launch = parseLaunch(JSON.parse(await readFile(join(options.stateDirectory, "launch.json"), "utf8")) as unknown);
  const apiKey = options.apiKey ?? process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OpenCode Go host key is unavailable; configure it on the trusted host");
  if (options.overageConfirmedDisabled !== true) {
    throw new Error("OpenCode Go unattended use is blocked until Use balance is confirmed disabled");
  }
  const log = join(options.stateDirectory, "runtime.log");
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException("Terminal closed", "AbortError"));
  process.once("SIGHUP", stop); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const watchdog = setInterval(() => void (async () => {
    try {
      if (await readJsonIfPresent(join(options.stateDirectory, "cancel.json"))) {
        controller.abort(new DOMException("Controller requested stop", "AbortError")); return;
      }
      if (Date.now() - (await stat(join(options.stateDirectory, "heartbeat"))).mtimeMs > launch.controllerHeartbeatTimeoutMs) {
        controller.abort(new DOMException("Controller heartbeat lost", "TimeoutError"));
      }
    } catch { controller.abort(new DOMException("Controller heartbeat unavailable", "TimeoutError")); }
  })(), 250);
  watchdog.unref();
  let vm: VM | undefined; let vmId = "unstarted"; let hostPid: number | null = null; let started = false;
  try {
    const mediation = createOpenCodeGoMediation({ apiKey, sessionId: launch.piSessionId, placeholderNonce: launch.workerId.replaceAll("-", "") });
    const guestEnvironment = environment(launch, mediation.guestEnvironment);
    vm = await VM.create({
      allowWebSockets: false, autoStart: true, env: guestEnvironment, fetch: options.upstreamFetch,
      httpHooks: mediation.httpHooks, sessionLabel: `pi-lead:${launch.workerId}`, startTimeoutMs: 30_000,
      vfs: { mounts: {} },
    });
    vmId = vm.id; hostPid = vm.getHostPid(); await applyGuestCaEnvironment(vm, guestEnvironment);
    await writeJsonAtomically(join(options.stateDirectory, "resources.json"), { workerId: launch.workerId, vmId }); started = true;
    await vm.fs.mkdir("/workspace", { recursive: true, mode: 0o700 });
    await vm.fs.mkdir("/tmp/pi-agent", { recursive: true, mode: 0o700 });
    await vm.fs.mkdir("/tmp/pi-home", { recursive: true, mode: 0o700 });
    await stagePiBundle(vm, options.piBundleDirectory ?? bundleDirectory());
    const proc = vm.exec([
      "/usr/bin/node", "/opt/pi/dist/bundle/cli.js", "--mode", "json", "--no-session", "--session-id", launch.piSessionId,
      "--provider", "opencode-go", "--model", launch.modelId, "--thinking", "off", "--no-tools", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
      "--system-prompt", "Answer the bounded question. Do not use tools. Be concise.", "--", launch.question,
    ], { cwd: "/workspace", env: guestEnvironment, pty: true, signal: controller.signal, stdout: "pipe", stderr: "pipe" });
    let stdout = ""; let stderr = "";
    for await (const chunk of proc.output()) {
      if (chunk.stream === "stdout") stdout += chunk.text; else stderr += chunk.text;
      const safe = mediation.redactHostSecrets(chunk.text);
      await appendFile(log, safe, { encoding: "utf8", mode: 0o600 }); options.liveOutput?.(safe);
    }
    const result = await proc;
    if (mediation.redactHostSecrets(stdout) !== stdout || mediation.redactHostSecrets(stderr) !== stderr) {
      throw new Error("OpenCode Go provider attempted to expose the host key");
    }
    let parsed;
    try { parsed = parsePiJsonResult(stdout, launch.piSessionId); }
    catch (error) {
      const detail = `${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr.trim()}` : ""}`;
      const failure = classifyOpenCodeGoFailure(detail);
      if (!result.ok && failure) parsed = { status: "failed" as const, failure, detail, nativeEvents: [] };
      else throw new Error(detail);
    }
    await writeJsonAtomically(join(options.stateDirectory, "result.json"), {
      taskId: launch.taskId, assignmentId: launch.assignmentId, workerId: launch.workerId, vmId,
      tabId: launch.tabId, paneId: launch.paneId, piSessionId: launch.piSessionId, ...parsed,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeJsonAtomically(join(options.stateDirectory, started ? "error.json" : "launch-error.json"), {
      ...(started ? {} : { reason: "NATIVE_CONTROL_UNAVAILABLE" }), detail,
    });
    await appendFile(log, `PI Lead worker BLOCKED: ${detail}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    clearInterval(watchdog); process.off("SIGHUP", stop); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    let terminated = !vm;
    if (vm) { try { hostPid ??= vm.getHostPid(); await vm.close(); terminated = await observeProcessExit(hostPid, 5_000); } catch { terminated = false; } }
    await writeJsonAtomically(join(options.stateDirectory, "termination.json"), { vmId, terminated });
  }
}
