import { access, appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { createHttpHooks, VM } from "@earendil-works/gondolin";
import { observeProcessExit } from "./process-observation.ts";
import { isRecord, writeJsonAtomically } from "./state-files.ts";
import { waitForControllerDispatch } from "./controller-dispatch.ts";

const FIXTURE_SCRIPT = String.raw`
set -eu
sleep "$PI_LEAD_HOLD_SECONDS"
mkdir -p /workspace "$PI_LEAD_PRIVATE_PATH"
cd /workspace
printf 'isolated fixture\n' > fixture.txt

for forbidden in HERDR_SOCKET_PATH SSH_AUTH_SOCK OPENAI_API_KEY CODEX_HOME; do
  if printenv "$forbidden" >/dev/null 2>&1; then
    printf 'forbidden host environment: %s\n' "$forbidden" >&2
    exit 92
  fi
done

if ! command -v wget >/dev/null 2>&1; then
  printf 'wget is required for the egress fixture\n' >&2
  exit 93
fi

if wget -q -T 2 -O /tmp/pi-lead-egress http://example.com; then
  printf 'default-denied egress unexpectedly succeeded\n' >&2
  exit 94
fi

printf 'PI_LEAD_RESULT={"taskId":"%s","assignmentId":"%s","workerId":"%s","vmId":"%s","tabId":"%s","paneId":"%s","output":"fixture complete: egress denied, host environment absent, private workspace writable"}\n' \
  "$PI_LEAD_TASK_ID" "$PI_LEAD_ASSIGNMENT_ID" "$PI_LEAD_WORKER_ID" \
  "$PI_LEAD_VM_ID" "$PI_LEAD_TAB_ID" "$PI_LEAD_PANE_ID"
`;

function requireString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") {
    throw new Error(`Invalid launch record: missing ${field}`);
  }
  return value[field];
}

function requireSafeId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new Error(`Invalid ${field}`);
  return id;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const stateDirectory = process.argv[2];
  if (!stateDirectory) throw new Error("Fixture launcher requires a state directory");
  const launch = JSON.parse(await readFile(join(stateDirectory, "launch.json"), "utf8")) as unknown;
  const taskId = requireSafeId(launch, "taskId");
  const assignmentId = requireSafeId(launch, "assignmentId");
  const workerId = requireSafeId(launch, "workerId");
  const tabId = requireSafeId(launch, "tabId");
  const paneId = requireSafeId(launch, "paneId");
  if (!isRecord(launch) || !isRecord(launch.policy)) throw new Error("Invalid launch policy");
  const policy = launch.policy;
  if (!isRecord(policy.network) || !isRecord(policy.filesystem) || !isRecord(policy.environment)) {
    throw new Error("Incomplete launch policy");
  }
  if (
    !Array.isArray(policy.network.allowedHosts) ||
    policy.network.allowedHosts.length !== 0 ||
    policy.network.allowWebSockets !== false ||
    !Array.isArray(policy.filesystem.hostMounts) ||
    policy.filesystem.hostMounts.length !== 0
  ) {
    throw new Error("Fixture launch policy is not isolated");
  }
  const environment = Object.fromEntries(
    Object.entries(policy.environment).map(([key, value]) => {
      if (typeof value !== "string") throw new Error(`Invalid environment value for ${key}`);
      return [key, value];
    }),
  );
  const privateWritablePaths = policy.filesystem.privateWritablePaths;
  if (!Array.isArray(privateWritablePaths) || typeof privateWritablePaths[1] !== "string") {
    throw new Error("Fixture policy has no private writable path");
  }

  const abortController = new AbortController();
  const abortForSignal = () => abortController.abort(new DOMException("Terminal closed", "AbortError"));
  process.once("SIGHUP", abortForSignal);
  process.once("SIGINT", abortForSignal);
  process.once("SIGTERM", abortForSignal);

  const heartbeatTimeoutMs =
    isRecord(launch) && typeof launch.controllerHeartbeatTimeoutMs === "number"
      ? launch.controllerHeartbeatTimeoutMs
      : 5_000;
  const fixtureHoldMs = isRecord(launch) && typeof launch.fixtureHoldMs === "number" ? launch.fixtureHoldMs : 0;
  if (!Number.isSafeInteger(fixtureHoldMs) || fixtureHoldMs < 0 || fixtureHoldMs > 60_000) {
    throw new Error("Invalid fixture hold duration");
  }
  let checkingHeartbeat = false;
  const watchdog = setInterval(() => {
    if (checkingHeartbeat || abortController.signal.aborted) return;
    checkingHeartbeat = true;
    void (async () => {
      try {
        if (await exists(join(stateDirectory, "cancel.json"))) {
          abortController.abort(new DOMException("Controller requested stop", "AbortError"));
          return;
        }
        const heartbeat = await stat(join(stateDirectory, "heartbeat"));
        if (Date.now() - heartbeat.mtimeMs > heartbeatTimeoutMs) {
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

  const hooks = createHttpHooks({ allowedHosts: [] });
  let vm: VM | undefined;
  let vmId = "unstarted";
  let hostPid: number | null = null;
  let terminated = false;
  const runtimeLogPath = join(stateDirectory, "runtime.log");
  try {
    vm = await VM.create({
      allowWebSockets: false,
      autoStart: true,
      env: environment,
      httpHooks: hooks.httpHooks,
      sessionLabel: `pi-lead:${workerId}`,
      startTimeoutMs: 30_000,
      vfs: null,
    });
    vmId = vm.id;
    hostPid = vm.getHostPid();
    await writeJsonAtomically(join(stateDirectory, "resources.json"), { workerId, vmId });
    await waitForControllerDispatch({
      stateDirectory,
      required: isRecord(launch) && launch.controllerAdmissionRequired === true,
      signal: abortController.signal,
    });
    const execEnvironment = {
      ...environment,
      PI_LEAD_PRIVATE_PATH: privateWritablePaths[1],
      PI_LEAD_HOLD_SECONDS: String(fixtureHoldMs / 1_000),
      PI_LEAD_VM_ID: vmId,
      PI_LEAD_TAB_ID: tabId,
      PI_LEAD_PANE_ID: paneId,
    };
    const processInVm = vm.exec(["/bin/sh", "-lc", FIXTURE_SCRIPT], {
      env: execEnvironment,
      signal: abortController.signal,
      stderr: "pipe",
      stdout: "pipe",
    });
    let stdout = "";
    for await (const chunk of processInVm.output()) {
      await appendFile(runtimeLogPath, chunk.data, { mode: 0o600 });
      if (chunk.stream === "stdout") {
        stdout += chunk.text;
        process.stdout.write(chunk.data);
      } else {
        process.stderr.write(chunk.data);
      }
    }
    const result = await processInVm;
    if (!result.ok) throw new Error(`Fixture exited with code ${result.exitCode}`);
    const marker = stdout
      .split("\n")
      .find((line) => line.startsWith("PI_LEAD_RESULT="));
    if (!marker) throw new Error("Fixture did not emit a correlated result");
    const guestResult = JSON.parse(marker.slice("PI_LEAD_RESULT=".length)) as unknown;
    await writeJsonAtomically(join(stateDirectory, "result.json"), guestResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomically(join(stateDirectory, "error.json"), {
      message,
      name: error instanceof Error ? error.name : "Error",
    });
    try {
      await appendFile(runtimeLogPath, `PI Lead fixture BLOCKED: ${message}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // The durable error artifact remains authoritative if terminal logging fails.
    }
    process.exitCode = 1;
  } finally {
    clearInterval(watchdog);
    if (vm) {
      try {
        await vm.close();
        terminated = await observeProcessExit(hostPid, 5_000);
      } catch {
        terminated = false;
      }
    } else {
      terminated = true;
    }
    await writeJsonAtomically(join(stateDirectory, "termination.json"), { vmId, terminated });
  }
}

await main();
