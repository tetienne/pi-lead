export const GUEST_MISE_SEED_DIRECTORY = "/opt/pi-lead/mise-seed" as const;

export const PRIVATE_MISE_ENVIRONMENT_KEYS = [
  "MISE_AUTO_UPDATE",
  "MISE_CACHE_DIR",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_STATE_DIR",
  "MISE_USE_VERSIONS_HOST",
  "MISE_USE_VERSIONS_HOST_TRACK",
  "PI_LEAD_MISE_SEED",
] as const;

export type PrivateMiseEnvironment = {
  MISE_AUTO_UPDATE: "0";
  MISE_CACHE_DIR: string;
  MISE_CONFIG_DIR: string;
  MISE_DATA_DIR: string;
  MISE_STATE_DIR: string;
  MISE_USE_VERSIONS_HOST: "0";
  MISE_USE_VERSIONS_HOST_TRACK: "0";
  PI_LEAD_MISE_SEED: typeof GUEST_MISE_SEED_DIRECTORY;
};

export function createPrivateMiseEnvironment(workerId: string): PrivateMiseEnvironment {
  const privateRoot = `/tmp/pi-lead-${workerId}/mise`;
  return {
    MISE_AUTO_UPDATE: "0",
    MISE_CACHE_DIR: `${privateRoot}/cache`,
    MISE_CONFIG_DIR: `${privateRoot}/config`,
    MISE_DATA_DIR: `${privateRoot}/data`,
    MISE_STATE_DIR: `${privateRoot}/state`,
    MISE_USE_VERSIONS_HOST: "0",
    MISE_USE_VERSIONS_HOST_TRACK: "0",
    PI_LEAD_MISE_SEED: GUEST_MISE_SEED_DIRECTORY,
  };
}

export function parsePrivateMiseEnvironment(value: unknown): PrivateMiseEnvironment {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid toolchain cache environment");
  }
  const source = value as Record<string, unknown>;
  const environment = Object.fromEntries(PRIVATE_MISE_ENVIRONMENT_KEYS.map((name) => {
    const field = source[name];
    if (typeof field !== "string") throw new Error("Invalid toolchain cache environment");
    return [name, field];
  })) as PrivateMiseEnvironment;
  if (
    environment.MISE_AUTO_UPDATE !== "0" ||
    environment.MISE_USE_VERSIONS_HOST !== "0" ||
    environment.MISE_USE_VERSIONS_HOST_TRACK !== "0" ||
    environment.PI_LEAD_MISE_SEED !== GUEST_MISE_SEED_DIRECTORY ||
    !environment.MISE_CACHE_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_CONFIG_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_DATA_DIR.startsWith("/tmp/pi-lead-") ||
    !environment.MISE_STATE_DIR.startsWith("/tmp/pi-lead-")
  ) {
    throw new Error("Toolchain cache writes are not private to the guest worker");
  }
  return environment;
}
