import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Tier = "fast" | "standard" | "deep";

export type TierRoute = {
  /** `provider/model-id`. Omitted means "the model the Lead is using". */
  model?: string;
  thinking: ThinkingLevel;
  /**
   * Tried in order when `model` is not available (no auth for its provider, or
   * missing from the installed Pi catalog). `thinking` defaults to the tier's.
   */
  fallbacks?: { model: string; thinking?: ThinkingLevel }[];
};

/** A sidecar container a worker's VM can reach over TCP by name (e.g. Postgres). */
export type SandboxService = {
  name: string;
  image: string;
  port: number;
  env?: Record<string, string>;
};

export type LeadConfig = {
  tiers: Record<Tier, TierRoute>;
  maxWorkers: number;
  sandbox: {
    /** Gondolin image selector with git and mise. Unset: the image released with this version (src/image.ts). */
    image?: string;
    /** Hosts allowed without asking anyone. */
    allowedHosts: string[];
    memory?: string;
    cpus?: number;
    /** Docker containers the Lead starts per worker, reachable from the VM by name. */
    services?: SandboxService[];
  };
  jev: {
    /** Environment variable holding a TypeSafe or OpenRouter key. */
    apiKeyEnv: string;
    /** `openrouter` routes through OpenRouter's System One endpoint. */
    via: "typesafe" | "openrouter";
    model: string;
    /** Conservative price used to charge the local daily budget. */
    inputUsdPerMillion: number;
    dailyBudgetUsd: number;
    /** Below this confidence a judgment is treated as "don't know". */
    minConfidence: number;
  };
  /** Keep the Herdr tab and clone of a worker that did not finish cleanly. */
  keepFailedWorkers: boolean;
  /**
   * `confirm`: once a worker report is in the conversation, every host tool
   * call of the Lead that can execute or write (bash, write, edit…) needs your
   * confirmation until you send a message yourself (see report-guard.ts).
   * Only the global config can turn it `off`.
   */
  leadGuard: LeadGuardMode;
  /** A worker waiting on a question this long without an answer is stopped and its tab closed. 0 disables. */
  waitingTimeoutMinutes: number;
  /**
   * Steer a worker whose shell commands keep failing with no file changed in
   * between (see worker/stuck.ts), once per prompt.
   */
  stuckDetection: boolean;
  /**
   * Shell command run in the worker's VM (cwd /workspace) when code work
   * finishes `done` or `partial`; a non-zero exit makes the result at most
   * `partial`. Read only from a trusted project's `.pi/pi-lead.json`: it is
   * per project, and the global config cannot set it.
   */
  verify?: string;
  /** The `verify` run is stopped after this long and counts as failed. */
  verifyTimeoutMinutes: number;
};

export type LeadGuardMode = "confirm" | "off";

export const DEFAULT_CONFIG: LeadConfig = {
  tiers: {
    fast: { thinking: "low" },
    standard: { thinking: "medium" },
    deep: { thinking: "high" },
  },
  maxWorkers: 2,
  sandbox: {
    allowedHosts: [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
    ],
  },
  jev: {
    apiKeyEnv: "PI_LEAD_JEV_API_KEY",
    via: "openrouter",
    model: "jev-1.13",
    inputUsdPerMillion: 0.05,
    dailyBudgetUsd: 1,
    minConfidence: 0.7,
  },
  keepFailedWorkers: true,
  leadGuard: "confirm",
  waitingTimeoutMinutes: 120,
  stuckDetection: true,
  verifyTimeoutMinutes: 15,
};

type PartialConfig = {
  tiers?: Partial<Record<Tier, Partial<TierRoute>>>;
  maxWorkers?: number;
  sandbox?: Partial<LeadConfig["sandbox"]>;
  jev?: Partial<LeadConfig["jev"]>;
  keepFailedWorkers?: boolean;
  leadGuard?: LeadGuardMode;
  waitingTimeoutMinutes?: number;
  stuckDetection?: boolean;
  verify?: string;
  verifyTimeoutMinutes?: number;
};

export function mergeConfig(base: LeadConfig, override: PartialConfig): LeadConfig {
  const tiers = { ...base.tiers };
  for (const tier of Object.keys(tiers) as Tier[]) {
    tiers[tier] = { ...tiers[tier], ...override.tiers?.[tier] };
  }
  return {
    tiers,
    maxWorkers: override.maxWorkers ?? base.maxWorkers,
    sandbox: { ...base.sandbox, ...override.sandbox },
    jev: { ...base.jev, ...override.jev },
    keepFailedWorkers: override.keepFailedWorkers ?? base.keepFailedWorkers,
    leadGuard: override.leadGuard === "off" || override.leadGuard === "confirm" ? override.leadGuard : base.leadGuard,
    waitingTimeoutMinutes: override.waitingTimeoutMinutes ?? base.waitingTimeoutMinutes,
    stuckDetection: typeof override.stuckDetection === "boolean" ? override.stuckDetection : base.stuckDetection,
    ...(typeof override.verify === "string" && override.verify.trim()
      ? { verify: override.verify.trim() }
      : base.verify !== undefined
        ? { verify: base.verify }
        : {}),
    verifyTimeoutMinutes:
      typeof override.verifyTimeoutMinutes === "number" && override.verifyTimeoutMinutes > 0
        ? override.verifyTimeoutMinutes
        : base.verifyTimeoutMinutes,
  };
}

async function readJson(path: string): Promise<PartialConfig | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PartialConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid PI Lead config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A path for a notice: `~` for the home directory, nothing else shortened. */
function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function has(value: PartialConfig, key: keyof PartialConfig): boolean {
  return typeof value === "object" && value !== null && key in value;
}

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_KEYS = new Set(["name", "image", "port", "env"]);

function serviceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!SERVICE_KEYS.has(key)) return `unknown key "${key}"`;
  if (typeof record.name !== "string" || !SERVICE_NAME.test(record.name)) return "invalid name";
  if (typeof record.image !== "string" || !record.image.trim() || /\s/.test(record.image) || record.image.startsWith("-")) return "invalid image";
  if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) return "invalid port";
  if (record.env !== undefined) {
    if (typeof record.env !== "object" || record.env === null) return "invalid env";
    for (const [envKey, envValue] of Object.entries(record.env as Record<string, unknown>)) {
      if (!ENV_KEY.test(envKey) || typeof envValue !== "string") return "invalid env";
    }
  }
  return undefined;
}

/** Drops `sandbox.services` in place and reports why, rather than throwing: one bad entry must not lose the rest of the config. */
function sanitizeServices(source: PartialConfig, label: string, ignored: string[]): void {
  const sandbox = source.sandbox as (Partial<LeadConfig["sandbox"]> & { services?: unknown }) | undefined;
  if (typeof sandbox !== "object" || sandbox === null || !("services" in sandbox)) return;
  const services = sandbox.services;
  const fail = (reason: string) => {
    ignored.push(`PI Lead: \`sandbox.services\` in ${label} is ignored (${reason}).`);
    delete sandbox.services;
  };
  if (!Array.isArray(services)) return fail("not an array");
  const names = new Set<string>();
  for (const [index, entry] of services.entries()) {
    const problem = serviceProblem(entry);
    if (problem) return fail(`entry ${index}: ${problem}`);
    const name = (entry as SandboxService).name;
    if (names.has(name)) return fail(`entry ${index}: duplicate name "${name}"`);
    names.add(name);
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Global `<agent dir>/pi-lead.json` (`~/.pi/agent` unless PI_CODING_AGENT_DIR
 * moves it), then project `.pi/pi-lead.json`. The project file can widen
 * egress, so it is read only for trusted projects, and it can never turn the
 * Lead guard off: a repository (or a worker's branch merged into it) must not
 * be able to disable the check that protects the host from worker reports.
 * `verify` is the reverse: a command for one project, so only the project
 * file sets it (it runs in the worker's VM, never on the host).
 *
 * `ignored` has one line per setting dropped by these rules, so the Lead can
 * say so instead of silently ignoring it. It names keys and paths only.
 */
export async function loadConfigWithNotices(
  cwd: string,
  options: { projectTrusted: boolean; agentDir?: string },
): Promise<{ config: LeadConfig; ignored: string[] }> {
  let config = DEFAULT_CONFIG;
  const ignored: string[] = [];
  const globalPath = join(options.agentDir ?? join(homedir(), ".pi", "agent"), "pi-lead.json");
  const projectPath = join(cwd, ".pi", "pi-lead.json");
  const global = await readJson(globalPath);
  if (global) {
    if (has(global, "verify")) {
      ignored.push(`PI Lead: \`verify\` in ${displayPath(globalPath)} is ignored; set it in the project's .pi/pi-lead.json.`);
      delete global.verify;
    }
    sanitizeServices(global, displayPath(globalPath), ignored);
    config = mergeConfig(config, global);
  }
  if (options.projectTrusted) {
    const project = await readJson(projectPath);
    if (project) {
      if (has(project, "leadGuard")) {
        ignored.push("PI Lead: `leadGuard` in .pi/pi-lead.json is ignored; only the global config can change it.");
        delete project.leadGuard;
      }
      sanitizeServices(project, ".pi/pi-lead.json", ignored);
      config = mergeConfig(config, project);
    }
  } else if (await exists(projectPath)) {
    ignored.push(
      "PI Lead: .pi/pi-lead.json is ignored because this project is not trusted in Pi (use /trust and restart Pi, or start it with --approve).",
    );
  }
  return { config, ignored };
}

export async function loadConfig(
  cwd: string,
  options: { projectTrusted: boolean; agentDir?: string },
): Promise<LeadConfig> {
  return (await loadConfigWithNotices(cwd, options)).config;
}
