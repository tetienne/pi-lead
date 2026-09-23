import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The worker's Pi runs on the host, so it must never read the guest-writable
 * clone: a guest could replace `AGENTS.md` with a symlink to a host secret, or
 * plant git config for a prompt that runs `git status`. Right after cloning,
 * before any guest runs, the host copies the repository's text resources out
 * of the clone (regular files only, no symlinks, bounded size) and Pi reads
 * the copies. Pi's cwd is a directory outside the clone.
 */

export const CONTEXT_FILES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"] as const;

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
  clonePath: string;
  /** Becomes the worker Pi's cwd; receives the context files Pi loads from its cwd. */
  workDir: string;
  /** Receives the project's skills, prompts and APPEND_SYSTEM.md (trusted projects only). */
  resourceDir: string;
  projectTrusted: boolean;
}): Promise<ProjectResources> {
  const budget: Budget = { bytes: 0, files: 0 };
  await mkdir(input.workDir, { recursive: true });
  for (const file of CONTEXT_FILES) {
    await copyRegularFile(join(input.clonePath, file), join(input.workDir, file), budget);
  }
  const resources: ProjectResources = { skills: [], prompts: [] };
  if (!input.projectTrusted) return resources;
  await mkdir(input.resourceDir, { recursive: true });
  const trees: Array<[string[], string, "skills" | "prompts"]> = [
    [[".agents", "skills"], "agents-skills", "skills"],
    [[".pi", "skills"], "pi-skills", "skills"],
    [[".pi", "prompts"], "prompts", "prompts"],
  ];
  for (const [parts, name, kind] of trees) {
    const target = join(input.resourceDir, name);
    if (await copyTree(join(input.clonePath, ...parts), target, budget)) resources[kind].push(target);
  }
  const append = join(input.resourceDir, "APPEND_SYSTEM.md");
  if (await copyRegularFile(join(input.clonePath, ".pi", "APPEND_SYSTEM.md"), append, budget)) resources.appendSystem = append;
  return resources;
}
