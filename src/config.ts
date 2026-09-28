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
  jev: {
    /** Environment variable holding a TypeSafe or OpenRouter key. */
    apiKeyEnv: string;
    /** `openrouter` routes through OpenRouter's System One endpoint. */
    via: "typesafe" | "openrouter";
    model: string;
    /** Below this confidence a judgment is treated as "don't know". */
    minConfidence: number;
  };
  /** Keep the Herdr worktree workspace of a worker that did not finish cleanly. */
  keepFailedWorkers: boolean;
  /**
   * Steer a worker whose shell commands keep failing with no file changed in
   * between (see worker/stuck.ts), once per prompt.
   */
  stuckDetection: boolean;
};

export const DEFAULT_CONFIG: LeadConfig = {
  tiers: {
    fast: { thinking: "low" },
    standard: { thinking: "medium" },
    deep: { thinking: "high" },
  },
  jev: {
    apiKeyEnv: "PI_LEAD_JEV_API_KEY",
    via: "openrouter",
    model: "jev-1.13",
    minConfidence: 0.7,
  },
  keepFailedWorkers: true,
  stuckDetection: true,
};

type PartialConfig = {
  tiers?: Partial<Record<Tier, Partial<TierRoute>>>;
  jev?: Partial<LeadConfig["jev"]>;
  keepFailedWorkers?: boolean;
  stuckDetection?: boolean;
};

const JEV_KEYS = ["apiKeyEnv", "via", "model", "minConfidence"] as const satisfies readonly (keyof LeadConfig["jev"])[];

/** Only today's keys: an old `dailyBudgetUsd` or `inputUsdPerMillion` is dropped without a notice. */
function mergeJev(base: LeadConfig["jev"], override: Partial<LeadConfig["jev"]> | undefined): LeadConfig["jev"] {
  const jev = { ...base };
  for (const key of JEV_KEYS) {
    if (override?.[key] !== undefined) (jev as Record<string, unknown>)[key] = override[key];
  }
  return jev;
}

/** Only today's keys: an old `verify` or `verifyTimeoutMinutes` is dropped without a notice. */
export function mergeConfig(base: LeadConfig, override: PartialConfig): LeadConfig {
  const tiers = { ...base.tiers };
  for (const tier of Object.keys(tiers) as Tier[]) {
    tiers[tier] = { ...tiers[tier], ...override.tiers?.[tier] };
  }
  return {
    tiers,
    jev: mergeJev(base.jev, override.jev),
    keepFailedWorkers: override.keepFailedWorkers ?? base.keepFailedWorkers,
    stuckDetection: typeof override.stuckDetection === "boolean" ? override.stuckDetection : base.stuckDetection,
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

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Global `<agent dir>/pi-lead.json` (`~/.pi/agent` unless PI_CODING_AGENT_DIR
 * moves it), then project `.pi/pi-lead.json`. The project file is read only
 * for trusted projects.
 *
 * `ignored` has one line per setting dropped by these rules, so the Lead can
 * say so instead of silently ignoring it. It names keys and paths only.
 */
export async function loadConfig(
  cwd: string,
  options: { projectTrusted: boolean; agentDir?: string },
): Promise<{ config: LeadConfig; ignored: string[] }> {
  let config = DEFAULT_CONFIG;
  const ignored: string[] = [];
  const globalPath = join(options.agentDir ?? join(homedir(), ".pi", "agent"), "pi-lead.json");
  const projectPath = join(cwd, ".pi", "pi-lead.json");
  const global = await readJson(globalPath);
  if (global) config = mergeConfig(config, global);
  if (options.projectTrusted) {
    const project = await readJson(projectPath);
    if (project) {
      config = mergeConfig(config, project);
    }
  } else if (await exists(projectPath)) {
    ignored.push(
      "PI Lead: .pi/pi-lead.json is ignored because this project is not trusted in Pi (use /trust and restart Pi, or start it with --approve).",
    );
  }
  return { config, ignored };
}
