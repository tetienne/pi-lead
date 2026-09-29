import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type LeadConfig = {
  /** Keep the Herdr worktree workspace of a worker that did not finish cleanly. */
  keepFailedWorkers: boolean;
  /**
   * Steer a worker whose shell commands keep failing with no file changed in
   * between (see worker/stuck.ts), once per prompt.
   */
  stuckDetection: boolean;
};

export const DEFAULT_CONFIG: LeadConfig = {
  keepFailedWorkers: true,
  stuckDetection: true,
};

type PartialConfig = Partial<LeadConfig>;

/**
 * Known keys only: any other (such as a removed setting: `tiers`, `jev`) is dropped without a
 * notice. A flag that is not a boolean keeps its default.
 */
export function mergeConfig(base: LeadConfig, override: PartialConfig): LeadConfig {
  return {
    keepFailedWorkers: typeof override.keepFailedWorkers === "boolean" ? override.keepFailedWorkers : base.keepFailedWorkers,
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
