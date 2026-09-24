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

export type LeadConfig = {
  tiers: Record<Tier, TierRoute>;
  maxWorkers: number;
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

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Global `<agent dir>/pi-lead.json` (`~/.pi/agent` unless PI_CODING_AGENT_DIR
 * moves it), then project `.pi/pi-lead.json`. The project file is read only
 * for trusted projects, and it can never turn the Lead guard off: a
 * repository (or a worker's branch merged into it) must not be able to
 * disable the check that protects the host from worker reports. `verify` is
 * the reverse: a command for one project, so only the project file sets it
 * (it runs on the host in the worker's own clone, never in the user's
 * checkout).
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
    config = mergeConfig(config, global);
  }
  if (options.projectTrusted) {
    const project = await readJson(projectPath);
    if (project) {
      if (has(project, "leadGuard")) {
        ignored.push("PI Lead: `leadGuard` in .pi/pi-lead.json is ignored; only the global config can change it.");
        delete project.leadGuard;
      }
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
