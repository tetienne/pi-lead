import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The worker's Pi runs on the host, in its own git worktree; Pi loads
 * AGENTS.md and reads the worktree's files directly, no isolation. Only
 * skills, prompts and APPEND_SYSTEM.md are copied out to a separate
 * directory: Pi trust-gates those per cwd, and a fresh worktree path is
 * untrusted.
 */

export type ProjectResources = { skills: string[]; prompts: string[]; appendSystem?: string };

const present = (path: string) => stat(path).catch(() => undefined);

/**
 * Copy a file or directory tree, following symlinks and skipping dangling
 * ones; false when `from` is missing or of the wrong type.
 */
async function copyIfPresent(from: string, to: string, type: "file" | "directory"): Promise<boolean> {
  const found = await present(from);
  if (!found || (type === "file" ? !found.isFile() : !found.isDirectory())) return false;
  await cp(from, to, { recursive: true, dereference: true, filter: async (source) => (await present(source)) !== undefined });
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
  await mkdir(input.resourceDir, { recursive: true });
  const trees: Array<[string[], string, "skills" | "prompts"]> = [
    [[".agents", "skills"], "agents-skills", "skills"],
    [[".pi", "skills"], "pi-skills", "skills"],
    [[".pi", "prompts"], "prompts", "prompts"],
  ];
  for (const [parts, name, kind] of trees) {
    const target = join(input.resourceDir, name);
    if (await copyIfPresent(join(input.worktreePath, ...parts), target, "directory")) resources[kind].push(target);
  }
  const append = join(input.resourceDir, "APPEND_SYSTEM.md");
  if (await copyIfPresent(join(input.worktreePath, ".pi", "APPEND_SYSTEM.md"), append, "file")) resources.appendSystem = append;
  return resources;
}
