import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The worker's Pi runs on the host, in its own git worktree; Pi loads
 * AGENTS.md and reads the worktree's files directly, no isolation. Only
 * skills, prompts and APPEND_SYSTEM.md are copied out to a separate
 * directory (regular files only, no symlinks, bounded size): Pi trust-gates
 * those per cwd, and a fresh worktree path is untrusted.
 */

const MAX_FILE_BYTES = 1 << 20;
const MAX_TOTAL_BYTES = 16 << 20;
const MAX_FILES = 2_000;

export type ProjectResources = { skills: string[]; prompts: string[]; appendSystem?: string };

type Budget = { bytes: number; files: number };

async function copyRegularFile(from: string, to: string, budget: Budget): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(from);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;
  if (budget.files + 1 > MAX_FILES || budget.bytes + stat.size > MAX_TOTAL_BYTES) return false;
  budget.files += 1;
  budget.bytes += stat.size;
  await copyFile(from, to);
  return true;
}

/** Copy a directory tree, skipping symlinks, devices and anything over budget. */
async function copyTree(from: string, to: string, budget: Budget): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(from);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name), budget);
    else if (entry.isFile()) await copyRegularFile(join(from, entry.name), join(to, entry.name), budget);
  }
  return true;
}

export async function snapshotProjectResources(input: {
  worktreePath: string;
  /** Receives the project's skills, prompts and APPEND_SYSTEM.md (trusted projects only). */
  resourceDir: string;
  projectTrusted: boolean;
}): Promise<ProjectResources> {
  const resources: ProjectResources = { skills: [], prompts: [] };
  if (!input.projectTrusted) return resources;
  const budget: Budget = { bytes: 0, files: 0 };
  await mkdir(input.resourceDir, { recursive: true });
  const trees: Array<[string[], string, "skills" | "prompts"]> = [
    [[".agents", "skills"], "agents-skills", "skills"],
    [[".pi", "skills"], "pi-skills", "skills"],
    [[".pi", "prompts"], "prompts", "prompts"],
  ];
  for (const [parts, name, kind] of trees) {
    const target = join(input.resourceDir, name);
    if (await copyTree(join(input.worktreePath, ...parts), target, budget)) resources[kind].push(target);
  }
  const append = join(input.resourceDir, "APPEND_SYSTEM.md");
  if (await copyRegularFile(join(input.worktreePath, ".pi", "APPEND_SYSTEM.md"), append, budget)) resources.appendSystem = append;
  return resources;
}
