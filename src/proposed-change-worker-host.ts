import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpHooks, VM, type VMOptions } from "@earendil-works/gondolin";

import {
  applyGuestCaEnvironment,
  createNativePiCredentialSource,
  parsePiJsonResult,
  stagePiBundle,
  type ChatGptCredentialSource,
} from "./chatgpt-worker-host.ts";
import { createChatGptMediation } from "./chatgpt-policy.ts";
import { PROPOSAL_REF } from "./git-proposal.ts";
import { observeProcessExit } from "./process-observation.ts";
import type { ValidationEvidence } from "./proposed-change-task.ts";
import { isRecord, readJsonIfPresent, writeJsonAtomically } from "./state-files.ts";
import { waitForControllerDispatch } from "./controller-dispatch.ts";
import {
  createReadonlyToolchainSeed,
  GUEST_MISE_VERSION,
  MISE_SEED_CONTENT_DIRECTORIES,
  type WorkerToolchainStorage,
} from "./worker-toolchain-storage.ts";
import { PI_REASONING_LEVELS, type PiReasoningLevel } from "./model-reasoning-routing.ts";

const GUEST_GIT_PACKAGE = "git=2.52.0-r0";
const GUEST_MISE_PACKAGE = `mise=${GUEST_MISE_VERSION}`;

type LaunchRecord = {
  taskId: string;
  assignmentId: string;
  instruction: string;
  namedBase: string;
  baseCommit: string;
  workerId: string;
  piSessionId: string;
  tabId: string;
  paneId: string;
  modelId: string;
  reasoning: PiReasoningLevel;
  workerMode: "change" | "research" | "validation-only";
  dependencyHosts: string[];
  validationTasks: string[];
  toolchainCache: WorkerToolchainStorage;
  controllerHeartbeatTimeoutMs: number;
  controllerAdmissionRequired: boolean;
};

function requireString(value: unknown, field: string, maxLength = 16_384): string {
  if (!isRecord(value) || typeof value[field] !== "string" || value[field].length > maxLength) {
    throw new Error(`Invalid proposed-change launch record: ${field}`);
  }
  return value[field];
}

function stringArray(value: unknown, field: string, maxEntries: number): string[] {
  if (!isRecord(value) || !Array.isArray(value[field]) || value[field].length > maxEntries) {
    throw new Error(`Invalid proposed-change launch record: ${field}`);
  }
  return value[field].map((entry) => {
    if (typeof entry !== "string") throw new Error(`Invalid ${field} entry`);
    return entry;
  });
}

function parseToolchainCache(value: unknown): WorkerToolchainStorage {
  if (!isRecord(value) || !isRecord(value.host) || !isRecord(value.guest) || !isRecord(value.environment)) {
    throw new Error("Invalid toolchain cache launch record");
  }
  if (
    (value.state !== "COLD" && value.state !== "WARM") ||
    typeof value.seedId !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.seedId) ||
    typeof value.host.seedDirectory !== "string" ||
    !value.host.seedDirectory.startsWith("/") ||
    (value.guest.platform !== "linux-arm64-musl" && value.guest.platform !== "linux-x64-musl") ||
    value.guest.seedDirectory !== "/opt/pi-lead/mise-seed"
  ) {
    throw new Error("Invalid toolchain cache launch record");
  }
  const environmentValue = value.environment;
  const environment = Object.fromEntries(
    ["MISE_CACHE_DIR", "MISE_CONFIG_DIR", "MISE_DATA_DIR", "MISE_STATE_DIR", "PI_LEAD_MISE_SEED"].map(
      (name) => {
        const field = environmentValue[name];
        if (typeof field !== "string") throw new Error("Invalid toolchain cache environment");
        return [name, field];
      },
    ),
  ) as WorkerToolchainStorage["environment"];
  if (
    environment.PI_LEAD_MISE_SEED !== value.guest.seedDirectory ||
    !environment.MISE_CACHE_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_CONFIG_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_DATA_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_STATE_DIR.startsWith("/tmp/pi-lead-")
  ) {
    throw new Error("Toolchain cache writes are not private to the guest worker");
  }
  return {
    state: value.state,
    seedId: value.seedId,
    host: { seedDirectory: value.host.seedDirectory },
    guest: { platform: value.guest.platform, seedDirectory: value.guest.seedDirectory },
    environment,
  } as WorkerToolchainStorage;
}

function parseLaunchRecord(value: unknown): LaunchRecord {
  if (!isRecord(value) || !isRecord(value.policy)) {
    throw new Error("Invalid proposed-change launch record");
  }
  const policy = value.policy;
  if (value.workerMode !== "change" && value.workerMode !== "research" && value.workerMode !== "validation-only") {
    throw new Error("Invalid proposed-change worker mode");
  }
  const workerMode = value.workerMode;
  if (
    !isRecord(policy.network) ||
    policy.network.allowWebSockets !== false ||
    !isRecord(policy.filesystem) ||
    policy.filesystem.guestWorkspace !== "/workspace" ||
    !Array.isArray(policy.filesystem.hostMounts) ||
    policy.filesystem.hostMounts.length !== 0 ||
    !Array.isArray(policy.validation)
  ) {
    throw new Error("Proposed-change launch policy is incomplete");
  }
  const allowedHosts = stringArray(policy.network, "allowedHosts", 17);
  if ((workerMode === "change" || workerMode === "research") && allowedHosts[0] !== "chatgpt.com") {
    throw new Error("Proposed-change provider destination is not pinned");
  }
  if (workerMode === "validation-only" && allowedHosts.includes("chatgpt.com")) {
    throw new Error("Validation-only feedback must not receive provider network access");
  }
  const validation = policy.validation.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.task !== "string" ||
      !Array.isArray(entry.command) ||
      entry.command.length !== 3 ||
      entry.command[0] !== "mise" ||
      entry.command[1] !== "run" ||
      entry.command[2] !== entry.task
    ) {
      throw new Error("Invalid proposed-change validation policy");
    }
    return entry.task;
  });
  const timeout = value.controllerHeartbeatTimeoutMs;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1_000) {
    throw new Error("Invalid controller heartbeat timeout");
  }
  const reasoning = requireString(value, "reasoning", 16);
  if (!(PI_REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new Error("Invalid proposed-change reasoning level");
  }
  return {
    taskId: requireString(value, "taskId", 160),
    assignmentId: requireString(value, "assignmentId", 160),
    instruction: requireString(value, "instruction", 8_000),
    namedBase: requireString(value, "namedBase", 200),
    baseCommit: requireString(value, "baseCommit", 64),
    workerId: requireString(value, "workerId", 160),
    piSessionId: requireString(value, "piSessionId", 160),
    tabId: requireString(value, "tabId", 160),
    paneId: requireString(value, "paneId", 160),
    modelId: requireString(value, "modelId", 160),
    reasoning: reasoning as PiReasoningLevel,
    workerMode,
    dependencyHosts: workerMode === "change" || workerMode === "research" ? allowedHosts.slice(1) : allowedHosts,
    validationTasks: validation,
    toolchainCache: parseToolchainCache(value.toolchainCache),
    controllerHeartbeatTimeoutMs: timeout,
    controllerAdmissionRequired: value.controllerAdmissionRequired === true,
  };
}

function resolvePiBundleDirectory(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(entry), "bundle");
}

function resolveResearchSkillPath(): string {
  return fileURLToPath(new URL("../.agents/skills/research/SKILL.md", import.meta.url));
}

function guestEnvironment(launch: LaunchRecord, secrets: Readonly<Record<string, string>>) {
  const privateRoot = `/tmp/pi-lead-${launch.workerId}`;
  return {
    HOME: `${privateRoot}/home`,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...launch.toolchainCache.environment,
    MISE_YES: "1",
    PI_CODING_AGENT_DIR: `${privateRoot}/pi-agent`,
    PI_CODING_AGENT_SESSION_DIR: `${privateRoot}/pi-sessions`,
    PI_LEAD_TASK_ID: launch.taskId,
    PI_LEAD_ASSIGNMENT_ID: launch.assignmentId,
    PI_LEAD_WORKER_ID: launch.workerId,
    PI_LEAD_PI_SESSION_ID: launch.piSessionId,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    ...secrets,
  };
}

async function seedPrivateMiseStorage(
  vm: VM,
  environment: Record<string, string>,
): Promise<void> {
  const destinations = {
    cache: environment.MISE_CACHE_DIR,
    data: environment.MISE_DATA_DIR,
  } as const;
  const directories = await vm.exec(
    ["/bin/mkdir", "-p", environment.MISE_CACHE_DIR, environment.MISE_CONFIG_DIR, environment.MISE_DATA_DIR, environment.MISE_STATE_DIR],
    { env: environment },
  );
  if (!directories.ok) throw new Error(`Private mise storage setup failed: ${directories.stderr.trim()}`);
  for (const directory of MISE_SEED_CONTENT_DIRECTORIES) {
    const source = `${environment.PI_LEAD_MISE_SEED}/${directory}`;
    try {
      await vm.fs.access(source);
    } catch {
      continue;
    }
    const copy = await vm.exec(["/bin/cp", "-a", `${source}/.`, destinations[directory]], {
      env: environment,
    });
    if (!copy.ok) throw new Error(`Read-only mise seed copy failed: ${copy.stderr.trim()}`);
  }
}

export async function assertGuestCachePlatform(
  vm: Pick<VM, "exec">,
  plan: WorkerToolchainStorage,
): Promise<void> {
  const architecture = await vm.exec(["/bin/uname", "-m"]);
  const expectedArchitecture = plan.guest.platform === "linux-arm64-musl" ? "aarch64" : "x86_64";
  if (!architecture.ok || architecture.stdout.trim() !== expectedArchitecture) {
    throw new Error(`Guest architecture does not match cache seed: expected ${expectedArchitecture}`);
  }
  const musl = await vm.exec(["/bin/sh", "-lc", "test -e /lib/ld-musl-*.so.1"]);
  if (!musl.ok) throw new Error("Guest ABI does not match the musl cache seed");
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
    baseCommit: launch.baseCommit,
  };
}

async function runChecked(
  vm: VM,
  command: string[],
  options: { cwd?: string; env: Record<string, string>; label: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await vm.exec(command, {
    cwd: options.cwd,
    env: options.env,
  });
  if (!result.ok) {
    throw new Error(
      `${options.label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

async function ensureGuestToolchain(vm: VM, environment: Record<string, string>): Promise<void> {
  const expectedMiseVersion = GUEST_MISE_VERSION.replace(/-r\d+$/, "");
  const hasPinnedMise = (result: { ok: boolean; stdout: string } | undefined): boolean =>
    result?.ok === true && result.stdout.trim().split(/\s+/, 1)[0] === expectedMiseVersion;
  let ready = true;
  for (const path of ["/usr/bin/git", "/usr/bin/mise"]) {
    try {
      await vm.fs.access(path);
    } catch {
      ready = false;
    }
  }
  const installed = ready
    ? await vm.exec(["/usr/bin/mise", "--version"], { env: environment })
    : undefined;
  const pinnedPackage = ready
    ? await vm.exec(["/sbin/apk", "info", "-e", GUEST_MISE_PACKAGE], { env: environment })
    : undefined;
  if (!hasPinnedMise(installed) || !pinnedPackage?.ok) {
    await runChecked(
      vm,
      ["/sbin/apk", "add", "--no-cache", GUEST_GIT_PACKAGE, GUEST_MISE_PACKAGE],
      {
        env: environment,
        label: "isolated pinned Git/mise installation",
      },
    );
  }
  const verified = await vm.exec(["/usr/bin/mise", "--version"], { env: environment });
  const verifiedPackage = await vm.exec(["/sbin/apk", "info", "-e", GUEST_MISE_PACKAGE], {
    env: environment,
  });
  if (!hasPinnedMise(verified) || !verifiedPackage.ok) {
    throw new Error(`Pinned guest mise ${GUEST_MISE_VERSION} is unavailable`);
  }
}

async function preparePrivateWorkspace(
  vm: VM,
  launch: LaunchRecord,
  stateDirectory: string,
  environment: Record<string, string>,
): Promise<void> {
  const bundle = await readFile(join(stateDirectory, "base.bundle"));
  if (bundle.byteLength > 64 * 1024 * 1024) throw new Error("Base bundle exceeds 64 MiB");
  await vm.fs.writeFile("/tmp/base.bundle", bundle);
  await runChecked(
    vm,
    ["/usr/bin/git", "clone", "--quiet", "--branch", launch.namedBase, "/tmp/base.bundle", "/workspace"],
    { env: environment, label: "private Git clone" },
  );
  const revision = await runChecked(vm, ["/usr/bin/git", "rev-parse", "HEAD"], {
    cwd: "/workspace",
    env: environment,
    label: "base revision check",
  });
  if (revision.stdout.trim() !== launch.baseCommit) {
    throw new Error("Private workspace base does not match the named committed base");
  }
}

async function runValidationTasks(
  vm: VM,
  launch: LaunchRecord,
  proposedCommit: string,
  environment: Record<string, string>,
  onOutput: (message: string) => Promise<void>,
): Promise<{ validations: ValidationEvidence[]; miseReadinessMs: number; validationExecutionMs: number }> {
  const readinessStartedAt = performance.now();
  await runChecked(vm, ["/usr/bin/mise", "trust", "--all", "--yes"], {
    cwd: "/workspace",
    env: environment,
    label: "isolated mise configuration trust",
  });
  const install = await vm.exec(["/usr/bin/mise", "install", "--yes"], {
    cwd: "/workspace",
    env: environment,
  });
  await onOutput(install.stdout);
  await onOutput(install.stderr);
  if (!install.ok) {
    throw new Error(`mise tool installation failed with exit code ${install.exitCode}`);
  }
  const miseReadinessMs = performance.now() - readinessStartedAt;
  const validations: ValidationEvidence[] = [];
  let validationExecutionMs = 0;
  for (const task of launch.validationTasks) {
    await runChecked(vm, ["/usr/bin/git", "reset", "--hard", proposedCommit], {
      cwd: "/workspace",
      env: environment,
      label: `validation workspace reset for ${task}`,
    });
    const executionStartedAt = performance.now();
    const result = await vm.exec(["/usr/bin/mise", "run", task], {
      cwd: "/workspace",
      env: environment,
    });
    validationExecutionMs += performance.now() - executionStartedAt;
    await onOutput(result.stdout);
    await onOutput(result.stderr);
    const drift = await vm.exec(["/usr/bin/git", "diff", "--quiet", proposedCommit, "--"], {
      cwd: "/workspace",
      env: environment,
    });
    if (drift.exitCode !== 0 && drift.exitCode !== 1) {
      throw new Error(`Unable to verify the proposal revision after mise run ${task}`);
    }
    validations.push({
      task,
      command: `mise run ${task}`,
      passed: result.ok && drift.exitCode === 0,
      exitCode: result.exitCode,
    });
  }
  await runChecked(vm, ["/usr/bin/git", "reset", "--hard", proposedCommit], {
    cwd: "/workspace",
    env: environment,
    label: "final validation workspace reset",
  });
  return { validations, miseReadinessMs, validationExecutionMs };
}

async function packageProposal(
  vm: VM,
  launch: LaunchRecord,
  environment: Record<string, string>,
  stateDirectory: string,
): Promise<string> {
  await vm.fs.writeFile(
    "/workspace/.git/config",
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
    { encoding: "utf8" },
  );
  await runChecked(vm, ["/usr/bin/git", "reset", "--mixed", launch.baseCommit], {
    cwd: "/workspace",
    env: environment,
    label: "proposal history normalization",
  });
  await runChecked(
    vm,
    ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "add", "-A"],
    { cwd: "/workspace", env: environment, label: "proposal staging" },
  );
  const changed = await vm.exec(["/usr/bin/git", "diff", "--cached", "--quiet"], {
    cwd: "/workspace",
    env: environment,
  });
  if (changed.exitCode === 0) throw new Error("Worker produced no proposed change");
  if (changed.exitCode !== 1) throw new Error("Unable to inspect the proposed change");
  await runChecked(
    vm,
    [
      "/usr/bin/git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=PI Lead isolated worker",
      "-c",
      "user.email=worker@pi-lead.invalid",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "PI Lead proposed tree (review required)",
    ],
    { cwd: "/workspace", env: environment, label: "proposal object creation" },
  );
  const revision = await runChecked(vm, ["/usr/bin/git", "rev-parse", "HEAD"], {
    cwd: "/workspace",
    env: environment,
    label: "proposal revision resolution",
  });
  const proposedCommit = revision.stdout.trim();
  await runChecked(
    vm,
    ["/usr/bin/git", "update-ref", PROPOSAL_REF, proposedCommit],
    { cwd: "/workspace", env: environment, label: "private proposal ref creation" },
  );
  await runChecked(
    vm,
    ["/usr/bin/git", "bundle", "create", "/tmp/proposal.bundle", PROPOSAL_REF],
    { cwd: "/workspace", env: environment, label: "proposal bundle creation" },
  );
  const proposalBundle = await vm.fs.readFile("/tmp/proposal.bundle");
  if (proposalBundle.byteLength > 64 * 1024 * 1024) {
    throw new Error("Proposal bundle exceeds 64 MiB");
  }
  await writeFile(join(stateDirectory, "proposal.bundle"), proposalBundle, { mode: 0o600 });
  return proposedCommit;
}

function requireFixturePath(path: string): string {
  if (
    !path ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) => part === "." || part === ".." || !part)
  ) {
    throw new Error("Fixture edit path escapes the private workspace");
  }
  return path;
}

export type RunProposedChangeWorkerHostOptions = {
  stateDirectory: string;
  credentialSource?: ChatGptCredentialSource;
  debugLog?: (message: string) => void;
  liveOutput?: (message: string) => void;
  upstreamFetch?: VMOptions["fetch"];
  piBundleDirectory?: string;
  fixtureEdit?: {
    path: string;
    contents: string;
    assertReadonlySeed?: boolean;
    expectedSeedFile?: { path: string; contents: string };
    writePrivateCachePoison?: boolean;
    assertNoPrivateCachePoison?: boolean;
  };
};

export async function runProposedChangeWorkerHost(
  options: RunProposedChangeWorkerHostOptions,
): Promise<void> {
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
  let getPolicyRejection = (): string | undefined => undefined;
  try {
    let redact = (value: string) => value;
    let effectiveReasoning = launch.reasoning;
    let environment: Record<string, string>;
    let httpHooks;
    if (options.fixtureEdit || launch.workerMode === "validation-only") {
      const allowedHosts = new Set([
        ...(launch.workerMode === "change" || launch.workerMode === "research" ? ["chatgpt.com"] : []),
        ...launch.dependencyHosts,
      ]);
      let firstPolicyRejection: string | undefined;
      const hooks = createHttpHooks({
        allowedHosts: [...allowedHosts],
        isRequestAllowed(request) {
          const url = new URL(request.url);
          if (url.protocol === "https:" && allowedHosts.has(url.hostname)) {
            return true;
          }
          firstPolicyRejection ??=
            `Dependency destination ${url.hostname} is not explicitly allowed`;
          return false;
        },
      });
      httpHooks = hooks.httpHooks;
      environment = guestEnvironment(launch, {});
      getPolicyRejection = () => firstPolicyRejection;
    } else {
      const credentialSource =
        options.credentialSource ?? (await createNativePiCredentialSource(abortController.signal));
      effectiveReasoning = credentialSource.assertModelAvailable(launch.modelId, launch.reasoning);
      const initialCredential = await credentialSource.getCredential(abortController.signal);
      const mediation = createChatGptMediation({
        initialCredential,
        placeholderNonce: launch.workerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128),
        refreshCredential: (signal) => credentialSource.getCredential(signal),
        additionalAllowedHosts: launch.dependencyHosts,
      });
      httpHooks = mediation.httpHooks;
      environment = guestEnvironment(launch, mediation.guestEnvironment);
      redact = mediation.redactHostSecrets;
      getPolicyRejection = mediation.getLastPolicyRejection;
    }
    const effectiveRoute = {
      provider: "openai-codex" as const,
      modelId: launch.modelId,
      reasoning: effectiveReasoning,
    };
    vm = await VM.create({
      allowWebSockets: false,
      autoStart: true,
      debugLog: options.debugLog,
      env: environment,
      fetch: options.upstreamFetch,
      httpHooks,
      sessionLabel: `pi-lead:${launch.workerId}`,
      startTimeoutMs: 30_000,
      vfs: {
        mounts: {
          [launch.toolchainCache.guest.seedDirectory]: createReadonlyToolchainSeed(launch.toolchainCache),
        },
      },
    });
    vmId = vm.id;
    hostPid = vm.getHostPid();
    await writeJsonAtomically(join(options.stateDirectory, "resources.json"), {
      workerId: launch.workerId,
      vmId,
      effectiveRoute,
    });
    resourcesStarted = true;
    await waitForControllerDispatch({
      stateDirectory: options.stateDirectory,
      required: launch.controllerAdmissionRequired,
      signal: abortController.signal,
    });
    abortController.signal.throwIfAborted();
    await applyGuestCaEnvironment(vm, environment);
    await assertGuestCachePlatform(vm, launch.toolchainCache);
    const seedCopyStartedAt = performance.now();
    await seedPrivateMiseStorage(vm, environment);
    const seedCopyMs = performance.now() - seedCopyStartedAt;
    const toolchainPreparationStartedAt = performance.now();
    await ensureGuestToolchain(vm, environment);
    const guestToolchainPreparationMs = performance.now() - toolchainPreparationStartedAt;
    await preparePrivateWorkspace(vm, launch, options.stateDirectory, environment);
    if (launch.workerMode === "validation-only") {
      // The feedback runner intentionally leaves the pinned base untouched and
      // executes only the allowlisted mise task below.
    } else if (options.fixtureEdit) {
      if (options.fixtureEdit.assertReadonlySeed) {
        const probe = await vm.exec(
          [
            "/bin/sh",
            "-lc",
            "if touch \"$PI_LEAD_MISE_SEED/.pi-lead-write-probe\" 2>/dev/null; then exit 20; fi",
          ],
          { env: environment },
        );
        if (!probe.ok) throw new Error("Guest could write to the shared mise seed");
      }
      if (options.fixtureEdit.expectedSeedFile) {
        const copiedSeed = await vm.fs.readFile(
          `${environment.MISE_DATA_DIR}/${options.fixtureEdit.expectedSeedFile.path}`,
          { encoding: "utf8" },
        );
        if (copiedSeed !== options.fixtureEdit.expectedSeedFile.contents) {
          throw new Error("Trusted mise seed was not copied into private worker storage");
        }
      }
      if (options.fixtureEdit.writePrivateCachePoison) {
        await vm.fs.writeFile(`${environment.MISE_DATA_DIR}/cross-worker-poison`, "poisoned");
      }
      if (options.fixtureEdit.assertNoPrivateCachePoison) {
        const privatePoison = await vm.fs.access(`${environment.MISE_DATA_DIR}/cross-worker-poison`).then(
          () => true,
          () => false,
        );
        const seedPoison = await vm.fs.access(`${environment.PI_LEAD_MISE_SEED}/data/cross-worker-poison`).then(
          () => true,
          () => false,
        );
        if (privatePoison || seedPoison) throw new Error("Cross-worker cache poison escaped private storage");
      }
      const editPath = requireFixturePath(options.fixtureEdit.path);
      await vm.fs.writeFile(
        "/tmp/pi-lead-fixture-edit.json",
        JSON.stringify({ path: `/workspace/${editPath}`, contents: options.fixtureEdit.contents }),
        { encoding: "utf8" },
      );
      await vm.fs.writeFile(
        "/tmp/pi-lead-fixture-worker.mjs",
        'import { readFile, writeFile } from "node:fs/promises";\nconst input = JSON.parse(await readFile("/tmp/pi-lead-fixture-edit.json", "utf8"));\nawait writeFile(input.path, input.contents, "utf8");\n',
        { encoding: "utf8" },
      );
      await runChecked(vm, ["/usr/bin/node", "/tmp/pi-lead-fixture-worker.mjs"], {
        cwd: "/workspace",
        env: environment,
        label: "isolated fixture worker",
      });
    } else {
      await stagePiBundle(vm, options.piBundleDirectory ?? resolvePiBundleDirectory());
      const privateRoot = `/tmp/pi-lead-${launch.workerId}`;
      await vm.fs.mkdir(`${privateRoot}/pi-agent`, { recursive: true, mode: 0o700 });
      const tokenEnv = environment.PI_LEAD_CHATGPT_TOKEN;
      if (!tokenEnv) throw new Error("Synthetic ChatGPT identity is unavailable");
      await vm.fs.writeFile(
        `${privateRoot}/pi-agent/models.json`,
        `${JSON.stringify({ providers: { "openai-codex": { apiKey: "$PI_LEAD_CHATGPT_TOKEN" } } })}\n`,
        { encoding: "utf8" },
      );
      await vm.fs.writeFile(
        `${privateRoot}/pi-agent/settings.json`,
        `${JSON.stringify({
          cacheWarming: "off",
          transport: "sse",
          defaultProjectTrust: "never",
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        })}\n`,
        { encoding: "utf8" },
      );
      const research = launch.workerMode === "research";
      const researchSkillPath = `${privateRoot}/skills/research/SKILL.md`;
      if (research) {
        await vm.fs.mkdir(`${privateRoot}/skills/research`, { recursive: true, mode: 0o700 });
        await vm.fs.writeFile(
          researchSkillPath,
          await readFile(resolveResearchSkillPath(), "utf8"),
          { encoding: "utf8" },
        );
      }
      const worker = vm.exec(
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
          effectiveRoute.modelId,
          "--thinking",
          effectiveRoute.reasoning,
          "--no-extensions",
          ...(research
            ? ["--skill", researchSkillPath]
            : ["--skill", "implement", "--skill", "tdd"]),
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-approve",
          "--offline",
          "--system-prompt",
          research
            ? "You are the isolated background agent required by the pinned Matt research skill. Use only explicitly allowed primary-source hosts, cite every material claim, and write exactly one Markdown research note in /workspace. Do not commit or change Git history; the host will validate and collect the note."
            : "Follow the pinned Matt implement and TDD skills: work one approved behavior at a time with a failing feedback loop before each minimal correction. Make the requested change in /workspace using the available tools. Do not commit, change Git history, or merely describe the edit. The host will run the required mise checks after you finish.",
          "--",
          launch.instruction,
        ],
        {
          cwd: "/workspace",
          env: environment,
          pty: true,
          signal: abortController.signal,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      let stdout = "";
      let stderr = "";
      for await (const chunk of worker.output()) {
        const safe = redact(chunk.text);
        if (safe !== chunk.text) throw new Error("Host credential appeared in worker output");
        await appendFile(runtimeLogPath, safe, { encoding: "utf8", mode: 0o600 });
        options.liveOutput?.(safe);
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 8 * 1024 * 1024) {
          throw new Error("Native Pi output exceeded 8 MiB");
        }
      }
      const result = await worker;
      const parsed = parsePiJsonResult(stdout, launch.piSessionId);
      if (!result.ok || parsed.status !== "answered") {
        throw new Error(parsed.status === "failed" ? parsed.detail : stderr.trim() || "Pi worker failed");
      }
    }
    const proposedCommit = await packageProposal(
      vm,
      launch,
      environment,
      options.stateDirectory,
    );
    const validation = await runValidationTasks(
      vm,
      launch,
      proposedCommit,
      environment,
      async (message) => {
        const safe = redact(message);
        if (safe !== message) throw new Error("Host credential appeared in validation output");
        if (safe) {
          await appendFile(runtimeLogPath, safe, { encoding: "utf8", mode: 0o600 });
          options.liveOutput?.(safe);
        }
      },
    );
    await writeJsonAtomically(join(options.stateDirectory, "result.json"), {
      ...identity(launch, vmId),
      status: "proposed",
      proposedCommit,
      validations: validation.validations,
      toolchainCache: {
        seedId: launch.toolchainCache.seedId,
        state: launch.toolchainCache.state,
        seedCopyMs,
        guestToolchainPreparationMs,
        miseReadinessMs: validation.miseReadinessMs,
        validationExecutionMs: validation.validationExecutionMs,
      },
    });
  } catch (error) {
    const policyRejection = getPolicyRejection();
    const dependencyDenied = policyRejection?.startsWith("Dependency destination ") === true;
    const detail = dependencyDenied
      ? policyRejection
      : error instanceof Error
        ? error.message
        : String(error);
    const target = resourcesStarted ? "error.json" : "launch-error.json";
    await writeJsonAtomically(join(options.stateDirectory, target), {
      reason: dependencyDenied ? "DEPENDENCY_DESTINATION_DENIED" : "RUNTIME_FAILURE",
      detail,
    });
    await appendFile(runtimeLogPath, `PI Lead change BLOCKED: ${detail}\n`, {
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
    await writeJsonAtomically(join(options.stateDirectory, "termination.json"), {
      vmId,
      terminated,
    });
  }
}
