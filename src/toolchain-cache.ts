import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ReadonlyProvider, RealFSProvider, type VirtualProvider } from "@earendil-works/gondolin";

const SAFE_WORKER_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MISE_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}-r\d+$/;
const GUEST_ARCHITECTURES = new Set(["arm64", "x64"]);
const SEED_MANIFEST = ".pi-lead-mise-seed.json";

export const GUEST_MISE_VERSION = "2025.8.20-r0";
export const MISE_SEED_CONTENT_DIRECTORIES = ["cache", "data"] as const;

export type GuestArchitecture = "arm64" | "x64";

export type ToolchainCachePlan = {
  state: "COLD" | "WARM";
  seedId: string;
  host: {
    seedDirectory: string;
  };
  guest: {
    platform: `linux-${GuestArchitecture}-musl`;
    seedDirectory: "/opt/pi-lead/mise-seed";
  };
  environment: {
    MISE_CACHE_DIR: string;
    MISE_CONFIG_DIR: string;
    MISE_DATA_DIR: string;
    MISE_STATE_DIR: string;
    PI_LEAD_MISE_SEED: "/opt/pi-lead/mise-seed";
  };
};

function requireWorkerId(workerId: string): string {
  if (!SAFE_WORKER_ID.test(workerId)) throw new Error("Invalid worker ID for toolchain cache");
  return workerId;
}

function requireGuestArchitecture(value: string): GuestArchitecture {
  if (!GUEST_ARCHITECTURES.has(value)) {
    throw new Error(`Unsupported Linux guest architecture for toolchain cache: ${value}`);
  }
  return value as GuestArchitecture;
}

function cacheKey(options: {
  miseConfig: string;
  miseVersion: string;
  platform: string;
}): string {
  return createHash("sha256")
    .update(options.platform)
    .update("\0")
    .update(options.miseVersion)
    .update("\0")
    .update(options.miseConfig)
    .digest("hex");
}

async function hasAttestedSeed(directory: string, seedId: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, SEED_MANIFEST), "utf8")) as unknown;
    return (
      typeof manifest === "object" &&
      manifest !== null &&
      "schemaVersion" in manifest &&
      manifest.schemaVersion === 1 &&
      "seedId" in manifest &&
      manifest.seedId === seedId &&
      "contentDirectories" in manifest &&
      Array.isArray(manifest.contentDirectories) &&
      manifest.contentDirectories.length === MISE_SEED_CONTENT_DIRECTORIES.length &&
      manifest.contentDirectories.every(
        (entry, index) => entry === MISE_SEED_CONTENT_DIRECTORIES[index],
      )
    );
  } catch {
    return false;
  }
}

export async function prepareToolchainCache(options: {
  root: string;
  workerId: string;
  miseConfig: string;
  miseVersion: string;
  guestArchitecture: string;
}): Promise<ToolchainCachePlan> {
  const workerId = requireWorkerId(options.workerId);
  if (!MISE_VERSION.test(options.miseVersion)) throw new Error("Invalid pinned guest mise version");
  const architecture = requireGuestArchitecture(options.guestArchitecture);
  const platform = `linux-${architecture}-musl` as const;
  const seedId = cacheKey({
    miseConfig: options.miseConfig,
    miseVersion: options.miseVersion,
    platform,
  });
  const cacheRoot = resolve(options.root);
  const seedDirectory = join(cacheRoot, "mise-seeds", platform, options.miseVersion, seedId);
  const state = (await hasAttestedSeed(seedDirectory, seedId)) ? "WARM" : "COLD";
  await mkdir(seedDirectory, { recursive: true, mode: 0o700 });

  const privateRoot = `/tmp/pi-lead-${workerId}/mise`;
  return {
    state,
    seedId,
    host: { seedDirectory },
    guest: { platform, seedDirectory: "/opt/pi-lead/mise-seed" },
    environment: {
      MISE_CACHE_DIR: `${privateRoot}/cache`,
      MISE_CONFIG_DIR: `${privateRoot}/config`,
      MISE_DATA_DIR: `${privateRoot}/data`,
      MISE_STATE_DIR: `${privateRoot}/state`,
      PI_LEAD_MISE_SEED: "/opt/pi-lead/mise-seed",
    },
  };
}

// Only a trusted host provisioning flow may call this. Worker-private guest caches
// have no host mount and are therefore never promoted automatically.
export async function attestToolchainSeed(plan: ToolchainCachePlan): Promise<void> {
  await mkdir(plan.host.seedDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(plan.host.seedDirectory, SEED_MANIFEST),
    `${JSON.stringify({
      schemaVersion: 1,
      seedId: plan.seedId,
      contentDirectories: MISE_SEED_CONTENT_DIRECTORIES,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function createReadonlyToolchainSeed(plan: ToolchainCachePlan): VirtualProvider {
  return new ReadonlyProvider(new RealFSProvider(plan.host.seedDirectory));
}
