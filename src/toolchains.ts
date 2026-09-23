import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig } from "./config.ts";
import type { Judge } from "./jev.ts";
import { createSandboxVm, GUEST_MISE_DIR, GUEST_WORKSPACE, guestEnv } from "./sandbox.ts";
import { createEgressPolicy } from "./worker/egress.ts";

/**
 * Project toolchains, the mise way. The host's own mise cache holds host
 * binaries (macOS on a Mac), which a Linux guest cannot run, so the guest has
 * its own: one directory per project, filled by `mise install` in a warm-up
 * VM the first time a worker needs it (or when the mise config changes), then
 * mounted read-only into every worker. After the first run it is instant.
 *
 * Each mise configuration gets its own cache directory, and the "ready"
 * marker lives outside it: a warm-up can only ever write the cache of the
 * configuration it installs, so a worker-authored mise.toml (a review of a
 * worker branch) cannot poison the tools other workers use.
 */

export const MISE_CONFIG_FILES = [
  "mise.toml",
  ".mise.toml",
  "mise/config.toml",
  ".mise/config.toml",
  ".config/mise.toml",
  ".config/mise/config.toml",
  ".tool-versions",
] as const;

/** Where mise and its core plugins download tools from. */
export const MISE_HOSTS = [
  "mise.jdx.dev",
  "mise-versions.jdx.dev",
  "github.com",
  "api.github.com",
  "*.githubusercontent.com",
  "nodejs.org",
  "static.rust-lang.org",
  "dl.google.com",
  "go.dev",
  "storage.googleapis.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

/** Content hash of the project's mise configuration, or undefined without one. */
export async function toolchainKey(clonePath: string, image: string | undefined): Promise<string | undefined> {
  const hash = createHash("sha256").update(`image=${image ?? "default"}\narch=${process.arch}\n`);
  let found = false;
  for (const file of MISE_CONFIG_FILES) {
    try {
      // The clone comes from the repository: never follow a committed symlink
      // (to a host secret or /dev/zero) from the host.
      const stat = await lstat(join(clonePath, file));
      if (!stat.isFile() || stat.size > 1 << 20) continue;
      const content = await readFile(join(clonePath, file));
      hash.update(`${file}\0`).update(content).update("\0");
      found = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found ? hash.digest("hex").slice(0, 16) : undefined;
}

export type Toolchains = {
  /** Returns the host cache directory to mount at /opt/mise, or undefined when the project has no mise config. */
  prepare(input: {
    repoRoot: string;
    clonePath: string;
    /** The sandbox the workers of this task use (its image decides which cache applies). */
    sandbox: LeadConfig["sandbox"];
    progress(text: string): void;
    confirm?: (question: string) => Promise<boolean>;
  }): Promise<string | undefined>;
};

export function createToolchains(options: {
  root: string;
  judge: Pick<Judge, "egress">;
}): Toolchains {
  const inFlight = new Map<string, Promise<string>>();

  const warmUp = async (cacheDir: string, marker: string, input: Parameters<Toolchains["prepare"]>[0]) => {
    await mkdir(cacheDir, { recursive: true });
    input.progress("installing the project's mise toolchains in a sandbox (first time only)");
    const vm = await createSandboxVm({
      label: "pi-lead toolchains",
      sandbox: input.sandbox,
      mounts: {
        [GUEST_WORKSPACE]: { host: input.clonePath, readonly: true },
        [GUEST_MISE_DIR]: { host: cacheDir },
      },
      allowRequest: createEgressPolicy({
        allowedHosts: [...MISE_HOSTS, ...input.sandbox.allowedHosts],
        task: `Install the toolchains declared in this project's mise configuration (${MISE_CONFIG_FILES.join(", ")}).`,
        judge: options.judge,
        ...(input.confirm ? { askHuman: input.confirm } : {}),
      }),
    });
    try {
      const env = guestEnv(true);
      const probe = await vm.exec(["/bin/sh", "-lc", "command -v mise"], { env });
      if (probe.exitCode !== 0) throw new Error("the Gondolin image has no mise; use PI Lead's default image or add mise to yours");
      const result = await vm.exec(["/bin/sh", "-lc", "mise install 2>&1"], { cwd: GUEST_WORKSPACE, env });
      if (result.exitCode !== 0) {
        throw new Error(`mise install failed:\n${result.stdout.split("\n").slice(-20).join("\n")}`);
      }
    } finally {
      await vm.close();
    }
    await writeFile(marker, new Date().toISOString());
    input.progress("mise toolchains ready");
    return cacheDir;
  };

  return {
    async prepare(input) {
      const key = await toolchainKey(input.clonePath, input.sandbox.image);
      if (!key) return undefined;
      const project = createHash("sha256").update(input.repoRoot).digest("hex").slice(0, 16);
      const cacheDir = join(options.root, project, key);
      const marker = join(options.root, project, `${key}.ready`);
      try {
        await access(marker);
        return cacheDir;
      } catch {
        // Not warmed up for this configuration yet.
      }
      let pending = inFlight.get(marker);
      if (!pending) {
        pending = warmUp(cacheDir, marker, input).finally(() => inFlight.delete(marker));
        inFlight.set(marker, pending);
      }
      return pending;
    },
  };
}
