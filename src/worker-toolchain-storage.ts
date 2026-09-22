import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ReadonlyProvider, RealFSProvider, type VirtualProvider } from "@earendil-works/gondolin";

import {
  createPrivateMiseEnvironment,
  GUEST_MISE_SEED_DIRECTORY,
  type PrivateMiseEnvironment,
} from "./mise-environment.ts";

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
    seedDirectory: typeof GUEST_MISE_SEED_DIRECTORY;
  };
  environment: PrivateMiseEnvironment;
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
  return {
    state: "COLD",
    seedId,
    host: { seedDirectory },
    guest: { platform, seedDirectory: GUEST_MISE_SEED_DIRECTORY },
    environment: createPrivateMiseEnvironment(options.workerId),
  };
}

export function createReadonlyToolchainSeed(plan: Pick<WorkerToolchainStorage, "host">): VirtualProvider {
  return new ReadonlyProvider(new RealFSProvider(plan.host.seedDirectory));
}
