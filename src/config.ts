import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Tier = "fast" | "standard" | "deep";

export type TierRoute = {
  /** `provider/model-id`. Omitted means "the model the Lead is using". */
  model?: string;
  thinking: ThinkingLevel;
};

export type LeadConfig = {
  tiers: Record<Tier, TierRoute>;
  maxWorkers: number;
  sandbox: {
    /** Gondolin image selector (for example `pi-lead:latest`, built with git). */
    image?: string;
    /** Hosts allowed without asking anyone. */
    allowedHosts: string[];
    memory?: string;
    cpus?: number;
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
};

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
};

type PartialConfig = {
  tiers?: Partial<Record<Tier, Partial<TierRoute>>>;
  maxWorkers?: number;
  sandbox?: Partial<LeadConfig["sandbox"]>;
  jev?: Partial<LeadConfig["jev"]>;
  keepFailedWorkers?: boolean;
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

/**
 * Global `~/.pi/agent/pi-lead.json`, then project `.pi/pi-lead.json`. The
 * project file can widen egress, so it is read only for trusted projects.
 */
export async function loadConfig(
  cwd: string,
  options: { projectTrusted: boolean; home?: string },
): Promise<LeadConfig> {
  let config = DEFAULT_CONFIG;
  const paths = [join(options.home ?? homedir(), ".pi", "agent", "pi-lead.json")];
  if (options.projectTrusted) paths.push(join(cwd, ".pi", "pi-lead.json"));
  for (const path of paths) {
    const override = await readJson(path);
    if (override) config = mergeConfig(config, override);
  }
  return config;
}
