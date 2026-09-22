import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ReadonlyProvider, RealFSProvider, type VirtualProvider } from "@earendil-works/gondolin";

const SAFE_WORKER_ID = /^[A-Za-z0-9._:-]{1,160}$/;

export const GUEST_MISE_VERSION = "2025.8.20-r0";
export const MISE_SEED_CONTENT_DIRECTORIES = ["cache", "data"] as const;

export type GuestArchitecture = "arm64" | "x64";

/**
 * A worker-private toolchain input. The current release never reuses or
 * promotes it: every worker gets a distinct empty, read-only seed plus private
 * writable mise directories inside its VM.
 */
export type WorkerToolchainStorage = {
  state: "COLD";
  seedId: string;
  host: { seedDirectory: string };
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

export async function preparePrivateWorkerToolchain(options: {
  root: string;
  workerId: string;
  guestArchitecture: GuestArchitecture;
}): Promise<WorkerToolchainStorage> {
  if (!SAFE_WORKER_ID.test(options.workerId)) throw new Error("Invalid worker ID for private toolchain storage");
  const platform = `linux-${options.guestArchitecture}-musl` as const;
  const seedId = createHash("sha256")
    .update("private-worker-toolchain\0")
    .update(platform)
    .update("\0")
    .update(options.workerId)
    .digest("hex");
  const seedDirectory = join(resolve(options.root), options.workerId, "empty-mise-seed");
  await mkdir(seedDirectory, { recursive: true, mode: 0o700 });
  const privateRoot = `/tmp/pi-lead-${options.workerId}/mise`;
  return {
    state: "COLD",
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

export function createReadonlyToolchainSeed(plan: Pick<WorkerToolchainStorage, "host">): VirtualProvider {
  return new ReadonlyProvider(new RealFSProvider(plan.host.seedDirectory));
}
