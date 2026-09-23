import { createHttpHooks, ReadonlyProvider, RealFSProvider, VM } from "@earendil-works/gondolin";

import type { LeadConfig } from "./config.ts";

export const GUEST_WORKSPACE = "/workspace";
export const GUEST_MISE_DIR = "/opt/mise";

/**
 * Pi's bash tool hands `exec` the full host environment (API keys included);
 * Pi's upstream Gondolin example forwards it into the guest. Guests here get a
 * fixed, minimal environment instead.
 */
export const BASE_GUEST_ENV: Readonly<Record<string, string>> = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  CI: "1",
};

/** mise inside the guest: tools live in the per-project cache at /opt/mise. */
export function guestEnv(withToolchains: boolean): Record<string, string> {
  if (!withToolchains) return { ...BASE_GUEST_ENV };
  return {
    ...BASE_GUEST_ENV,
    PATH: `${GUEST_MISE_DIR}/shims:${BASE_GUEST_ENV.PATH}`,
    MISE_DATA_DIR: GUEST_MISE_DIR,
    MISE_CACHE_DIR: "/tmp/mise-cache",
    MISE_STATE_DIR: "/tmp/mise-state",
    MISE_TRUSTED_CONFIG_PATHS: GUEST_WORKSPACE,
    MISE_YES: "1",
  };
}

export type Mount = { host: string; readonly?: boolean };

/** One Gondolin VM with explicit mounts and per-request egress policy. */
export async function createSandboxVm(options: {
  label: string;
  sandbox: LeadConfig["sandbox"];
  mounts: Record<string, Mount>;
  allowRequest: (request: { method: string; url: string }) => Promise<boolean>;
}): Promise<VM> {
  const { httpHooks } = createHttpHooks({
    // Hosts are decided per request; internal address ranges stay blocked.
    allowedHosts: ["*"],
    blockInternalRanges: true,
    isRequestAllowed: (request) => options.allowRequest({ method: request.method, url: request.url }),
  });
  const mounts = Object.fromEntries(
    Object.entries(options.mounts).map(([guest, mount]) => {
      const provider = new RealFSProvider(mount.host);
      return [guest, mount.readonly ? new ReadonlyProvider(provider) : provider];
    }),
  );
  return VM.create({
    sessionLabel: options.label,
    ...(options.sandbox.image ? { sandbox: { imagePath: options.sandbox.image } } : {}),
    ...(options.sandbox.memory ? { memory: options.sandbox.memory } : {}),
    ...(options.sandbox.cpus ? { cpus: options.sandbox.cpus } : {}),
    httpHooks,
    allowWebSockets: false,
    vfs: { mounts },
  });
}
