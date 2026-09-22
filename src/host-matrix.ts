import { readFile } from "node:fs/promises";

import { GUEST_MISE_VERSION } from "./toolchain-cache.ts";

export const HOST_MATRIX_CHECKS = [
  "toolchainVersions",
  "credentials",
  "mountNetwork",
  "termination",
  "herdrFocus",
] as const;

export type HostMatrixCheck = (typeof HOST_MATRIX_CHECKS)[number];
export type SupportedHostId = "macos-arm64" | "ubuntu-24.04-x64" | "ubuntu-24.04-arm64";

export type HostTarget = {
  id: SupportedHostId;
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  operatingSystem: "macOS" | "Ubuntu 24.04 LTS";
  guestPlatform: "linux-arm64-musl" | "linux-x64-musl";
};

export type HostObservation = Pick<HostTarget, "platform" | "architecture" | "operatingSystem"> | {
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  operatingSystem: "unknown";
};

export type HostMatrixPins = {
  node: string;
  pi: string;
  gondolin: string;
  mise: string;
};

export type HostCheckEvidence =
  | { status: "passed"; artifact: HostArtifactReference }
  | { status: "blocked"; detail: string }
  | { status: "failed"; detail: string };

export type HostScenarioIdentity = {
  taskId: string;
  assignmentId: string;
  workerId: string;
  vmId: string;
  piSessionId: string;
};

export type HostArtifactReference = {
  path: string;
  identity: HostScenarioIdentity;
};

export type HostScenarioEvidence = {
  versions: HostMatrixPins;
  checks: Record<HostMatrixCheck, HostCheckEvidence>;
};

export type HostMatrixScenario = {
  target: HostTarget;
  pins: HostMatrixPins;
  identity: HostScenarioIdentity;
};

export type HostMatrixResult = {
  target: HostTarget;
  observedHost: HostObservation;
  pins: HostMatrixPins;
  checks: Record<HostMatrixCheck, HostCheckEvidence>;
  missingChecks: HostMatrixCheck[];
  status: "DONE" | "BLOCKED" | "FAILED";
  detail: string;
};

export type CurrentReleaseDeferral = {
  target: "ubuntu-24.04-x64" | "ubuntu-24.04-arm64" | "opencode-go";
  reason: string;
};

const TARGETS: Record<SupportedHostId, HostTarget> = {
  "macos-arm64": {
    id: "macos-arm64",
    platform: "darwin",
    architecture: "arm64",
    operatingSystem: "macOS",
    guestPlatform: "linux-arm64-musl",
  },
  "ubuntu-24.04-x64": {
    id: "ubuntu-24.04-x64",
    platform: "linux",
    architecture: "x64",
    operatingSystem: "Ubuntu 24.04 LTS",
    guestPlatform: "linux-x64-musl",
  },
  "ubuntu-24.04-arm64": {
    id: "ubuntu-24.04-arm64",
    platform: "linux",
    architecture: "arm64",
    operatingSystem: "Ubuntu 24.04 LTS",
    guestPlatform: "linux-arm64-musl",
  },
};

const TARGET_IDS: readonly SupportedHostId[] = [
  "macos-arm64",
  "ubuntu-24.04-x64",
  "ubuntu-24.04-arm64",
];

const CURRENT_RELEASE_TARGET_IDS: readonly SupportedHostId[] = ["macos-arm64"];

const CURRENT_RELEASE_DEFERRALS: readonly CurrentReleaseDeferral[] = [
  {
    target: "ubuntu-24.04-x64",
    reason: "Ubuntu 24.04 x86_64 acceptance is deferred from the current release.",
  },
  {
    target: "ubuntu-24.04-arm64",
    reason: "Ubuntu 24.04 arm64 acceptance is deferred from the current release.",
  },
  {
    target: "opencode-go",
    reason: "A successful OpenCode Go worker is deferred until included quota is available.",
  },
];

const PINS: HostMatrixPins = {
  node: "24.14.1",
  pi: "0.86.1",
  gondolin: "0.12.0",
  mise: GUEST_MISE_VERSION,
};

function unavailableChecks(detail: string): Record<HostMatrixCheck, HostCheckEvidence> {
  return Object.fromEntries(
    HOST_MATRIX_CHECKS.map((check) => [check, { status: "blocked", detail }]),
  ) as Record<HostMatrixCheck, HostCheckEvidence>;
}

function missingChecks(checks: Record<HostMatrixCheck, HostCheckEvidence>): HostMatrixCheck[] {
  return HOST_MATRIX_CHECKS.filter((check) => checks[check].status !== "passed");
}

function sameIdentity(left: HostScenarioIdentity, right: HostScenarioIdentity): boolean {
  return (
    left.taskId === right.taskId &&
    left.assignmentId === right.assignmentId &&
    left.workerId === right.workerId &&
    left.vmId === right.vmId &&
    left.piSessionId === right.piSessionId
  );
}

function hasPinnedVersions(observed: HostMatrixPins, pins: HostMatrixPins): boolean {
  return (
    observed.node === pins.node &&
    observed.pi === pins.pi &&
    observed.gondolin === pins.gondolin &&
    observed.mise === pins.mise
  );
}

function checkDetail(check: HostCheckEvidence): string {
  return check.status === "passed" ? check.artifact.path : check.detail;
}

async function verifyScenarioEvidence(options: {
  evidence: HostScenarioEvidence;
  identity: HostScenarioIdentity;
  pins: HostMatrixPins;
  verifyArtifact: (artifact: HostArtifactReference) => Promise<boolean>;
}): Promise<Record<HostMatrixCheck, HostCheckEvidence>> {
  return Object.fromEntries(
    await Promise.all(
      HOST_MATRIX_CHECKS.map(async (name) => {
        const check = options.evidence.checks[name];
        if (!check || check.status !== "passed") {
          return [name, check?.detail?.trim() ? check : { status: "blocked", detail: "Missing host check evidence" }];
        }
        if (name === "toolchainVersions" && !hasPinnedVersions(options.evidence.versions, options.pins)) {
          return [name, { status: "blocked", detail: "Observed toolchain versions do not match the pinned host matrix" }];
        }
        if (!check.artifact.path.startsWith("/") || !sameIdentity(check.artifact.identity, options.identity)) {
          return [name, { status: "blocked", detail: "Host check artifact is not correlated to this worker assignment" }];
        }
        if (!(await options.verifyArtifact(check.artifact))) {
          return [name, { status: "blocked", detail: "Host check artifact was not collected and verified" }];
        }
        return [name, check];
      }),
    ),
  ) as Record<HostMatrixCheck, HostCheckEvidence>;
}

export function supportedHostTarget(id: SupportedHostId): HostTarget {
  return TARGETS[id];
}

export function currentReleaseDeferrals(): readonly CurrentReleaseDeferral[] {
  return CURRENT_RELEASE_DEFERRALS;
}

export async function currentHostObservation(): Promise<HostObservation> {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    (process.arch !== "arm64" && process.arch !== "x64")
  ) {
    throw new Error(`Unsupported host for the PI Lead matrix: ${process.platform}/${process.arch}`);
  }
  if (process.platform === "darwin") {
    return { platform: "darwin", architecture: process.arch, operatingSystem: "macOS" };
  }
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  const isUbuntu2404 = /^ID=ubuntu$/m.test(release) && /^VERSION_ID="?24\.04"?$/m.test(release);
  return {
    platform: "linux",
    architecture: process.arch,
    operatingSystem: isUbuntu2404 ? "Ubuntu 24.04 LTS" : "unknown",
  };
}

export async function runHostMatrixScenario(options: {
  target: HostTarget;
  observedHost?: HostObservation;
  identity: HostScenarioIdentity;
  verifyArtifact: (artifact: HostArtifactReference) => Promise<boolean>;
  execute: (scenario: HostMatrixScenario) => Promise<HostScenarioEvidence>;
}): Promise<HostMatrixResult> {
  const observedHost = options.observedHost ?? (await currentHostObservation());
  const target = supportedHostTarget(options.target.id);
  const targetMatches =
    target.platform === observedHost.platform &&
    target.architecture === observedHost.architecture &&
    target.operatingSystem === observedHost.operatingSystem;
  if (!targetMatches) {
    const detail = `Host matrix scenario requires ${target.id} (${target.operatingSystem}); observed ${observedHost.platform}/${observedHost.architecture} (${observedHost.operatingSystem})`;
    return {
      target,
      observedHost,
      pins: PINS,
      checks: unavailableChecks(detail),
      missingChecks: [...HOST_MATRIX_CHECKS],
      status: "BLOCKED",
      detail,
    };
  }

  const evidence = await options.execute({ target, pins: PINS, identity: options.identity });
  const checks = await verifyScenarioEvidence({
    evidence,
    identity: options.identity,
    pins: PINS,
    verifyArtifact: options.verifyArtifact,
  });
  const missing = missingChecks(checks);
  const failed = missing.some((check) => checks[check].status === "failed");
  const detail =
    missing.length === 0
      ? `Host matrix scenario completed on ${target.id}`
      : missing.map((check) => `${check}: ${checkDetail(checks[check])}`).join("; ");
  return {
    target,
    observedHost,
    pins: PINS,
    checks,
    missingChecks: missing,
    status: missing.length === 0 ? "DONE" : failed ? "FAILED" : "BLOCKED",
    detail,
  };
}

// This is intentionally local-host only: an unrun target is recorded as BLOCKED
// instead of being treated as compatible through its sibling's result.
export async function runSupportedHostMatrix(options: {
  observedHost?: HostObservation;
  identity: HostScenarioIdentity;
  verifyArtifact: (artifact: HostArtifactReference) => Promise<boolean>;
  execute: (scenario: HostMatrixScenario) => Promise<HostScenarioEvidence>;
}): Promise<HostMatrixResult[]> {
  const observedHost = options.observedHost ?? (await currentHostObservation());
  return Promise.all(
    TARGET_IDS.map((id) =>
      runHostMatrixScenario({
        target: supportedHostTarget(id),
        observedHost,
        identity: options.identity,
        verifyArtifact: options.verifyArtifact,
        execute: options.execute,
      }),
    ),
  );
}

// Current-release acceptance is intentionally narrower than the supported-host
// matrix. Deferred targets stay visible through currentReleaseDeferrals instead
// of being inferred from macOS evidence.
export async function runCurrentReleaseHostMatrix(options: {
  observedHost?: HostObservation;
  identity: HostScenarioIdentity;
  verifyArtifact: (artifact: HostArtifactReference) => Promise<boolean>;
  execute: (scenario: HostMatrixScenario) => Promise<HostScenarioEvidence>;
}): Promise<HostMatrixResult[]> {
  const observedHost = options.observedHost ?? (await currentHostObservation());
  return Promise.all(
    CURRENT_RELEASE_TARGET_IDS.map((id) =>
      runHostMatrixScenario({
        target: supportedHostTarget(id),
        observedHost,
        identity: options.identity,
        verifyArtifact: options.verifyArtifact,
        execute: options.execute,
      }),
    ),
  );
}
