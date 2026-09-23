import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeadConfig } from "./config.ts";
import type { Judge } from "./jev.ts";
import { createSandboxVm, GUEST_MISE_DIR, GUEST_WORKSPACE, guestEnv } from "./sandbox.ts";
import { createEgressPolicy } from "./worker/egress.ts";

/** Where the host cache mounts during warm-up, so /opt/mise itself can be guest-local (see warmUp). */
const GUEST_MISE_CACHE = "/opt/mise-cache";

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

/**
 * Walks a toolchain cache and marks every ELF binary or shebang script executable.
 * Never follows symlinks (mise installs are full of them, pointing at siblings already
 * fixed up or still to come) and never touches anything that isn't a regular file.
 */
export async function chmodExecutables(dir: string): Promise<void> {
  const names = await readdir(dir);
  for (const name of names) {
    const path = join(dir, name);
    const stat = await lstat(path); // lstat, never stat: a symlink must never be followed here
    if (stat.isDirectory()) {
      await chmodExecutables(path);
      continue;
    }
    if (!stat.isFile()) continue; // skips symlinks and other non-regular entries
    const head = Buffer.alloc(4);
    const handle = await open(path, "r");
    try {
      await handle.read(head, 0, 4, 0);
    } finally {
      await handle.close();
    }
    const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    const isShebang = head[0] === 0x23 && head[1] === 0x21;
    if (isElf || isShebang) await chmod(path, 0o755);
  }
}

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
      // Gondolin's VFS has no chmod/setattr, so anything mise installs straight onto the
      // mounted host cache would land there mode 0644 and fail to execute. Give /opt/mise
      // room in guest memory instead, and only copy the result onto the host afterwards.
      sandbox: { ...input.sandbox, memory: input.sandbox.memory ?? "3g" },
      mounts: {
        [GUEST_WORKSPACE]: { host: input.clonePath, readonly: true },
        [GUEST_MISE_CACHE]: { host: cacheDir },
      },
      allowRequest: createEgressPolicy({
        allowedHosts: [...MISE_HOSTS, ...input.sandbox.allowedHosts],
        task: `Install the toolchains declared in this project's mise configuration (${MISE_CONFIG_FILES.join(", ")}).`,
        judge: options.judge,
        ...(input.confirm ? { askHuman: input.confirm } : {}),
      }),
    });
    try {
      // mise's HTTP timeout (30s) is shorter than the 120s the lead gives a human to
      // confirm an egress request, so a paused download would die before an answer lands.
      const env = { ...guestEnv(true), MISE_HTTP_TIMEOUT: "180s" };
      const probe = await vm.exec(["/bin/sh", "-lc", "command -v mise"], { env });
      if (probe.exitCode !== 0) throw new Error("the Gondolin image has no mise; use PI Lead's default image or add mise to yours");
      const tmpfs = await vm.exec(["/bin/sh", "-lc", `mkdir -p ${GUEST_MISE_DIR} && mount -t tmpfs tmpfs ${GUEST_MISE_DIR}`], { env });
      if (tmpfs.exitCode !== 0) throw new Error(`failed to set up ${GUEST_MISE_DIR}:\n${tmpfs.stdout}`);
      const result = await vm.exec(["/bin/sh", "-lc", "mise install 2>&1"], { cwd: GUEST_WORKSPACE, env });
      if (result.exitCode !== 0) {
        throw new Error(`mise install failed:\n${result.stdout.split("\n").slice(-20).join("\n")}`);
      }
      const copy = await vm.exec(["/bin/sh", "-lc", `cp -a ${GUEST_MISE_DIR}/. ${GUEST_MISE_CACHE}/`], { env });
      if (copy.exitCode !== 0) throw new Error(`failed to copy toolchains to the host cache:\n${copy.stdout}`);
    } finally {
      await vm.close();
    }
    // The copy above went through the same chmod-less VFS, so fix up exec bits on the host
    // directly (a plain filesystem chmod, outside the guest, is unaffected by that limitation).
    await chmodExecutables(cacheDir);
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
