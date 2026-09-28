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
  /** `review` routes the worker's code review; without it, reviews take the `standard` tier's route (its model if set, else the Lead's), possibly the worker's own model. */
  tiers: Record<Tier, TierRoute> & { review?: TierRoute };
  /** Keep the Herdr worktree workspace of a worker that did not finish cleanly. */
  keepFailedWorkers: boolean;
  /** A worker waiting on a question this long without an answer is stopped and its tab closed. 0 disables. */
  waitingTimeoutMinutes: number;
};

export const DEFAULT_CONFIG: LeadConfig = {
  tiers: {
    fast: { thinking: "low" },
    standard: { thinking: "medium" },
    deep: { thinking: "high" },
  },
  keepFailedWorkers: true,
  waitingTimeoutMinutes: 120,
};

type PartialConfig = {
  tiers?: Partial<Record<Tier | "review", Partial<TierRoute>>>;
  keepFailedWorkers?: boolean;
  waitingTimeoutMinutes?: number;
};

export function mergeConfig(base: LeadConfig, override: PartialConfig): LeadConfig {
  const tiers = { ...base.tiers };
  for (const tier of ["fast", "standard", "deep"] as const) {
    tiers[tier] = { ...tiers[tier], ...override.tiers?.[tier] };
  }
  const review = override.tiers?.review;
  if (review) tiers.review = { thinking: tiers.standard.thinking, ...base.tiers.review, ...review };
  return {
    tiers,
    keepFailedWorkers: override.keepFailedWorkers ?? base.keepFailedWorkers,
    waitingTimeoutMinutes: override.waitingTimeoutMinutes ?? base.waitingTimeoutMinutes,
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
export async function loadConfigWithNotices(
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
    if (project) config = mergeConfig(config, project);
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
