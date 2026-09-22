import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ParsedProposedChangeInput } from "./proposed-change-input.ts";

const execFileAsync = promisify(execFile);
const CONVENTIONAL_VALIDATION_TASKS = ["test", "typecheck", "lint", "check"] as const;

type RepositoryIntake = {
  currentBranch(cwd: string): Promise<string>;
  specificationSources(cwd: string): Promise<readonly string[]>;
  miseTasks(cwd: string): Promise<readonly string[]>;
};

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function defaultSpecificationSources(cwd: string): Promise<readonly string[]> {
  const candidates = ["spec.md", "SPEC.md", "docs/spec.md"];
  try {
    for (const entry of await readdir(join(cwd, ".scratch"), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        candidates.push(`.scratch/${entry.name}/spec.md`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing: string[] = [];
  for (const source of candidates) {
    if (await isRegularFile(join(cwd, source))) existing.push(source);
  }
  return existing;
}

async function defaultMiseTasks(cwd: string): Promise<readonly string[]> {
  const discovered = new Set<string>();
  for (const source of [".mise.toml", "mise.toml", "mise.local.toml"]) {
    const contents = await readBoundedRegularFile(join(cwd, source), 256 * 1024);
    if (contents === undefined) continue;
    let section = "";
    for (const line of contents.split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
      if (heading) {
        section = heading[1] ?? "";
        for (const task of CONVENTIONAL_VALIDATION_TASKS) {
          if (section === `tasks.${task}` || section === `tasks."${task}"` || section === `tasks.'${task}'`) {
            discovered.add(task);
          }
        }
        continue;
      }
      if (section === "tasks") {
        const assignment = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
        if (assignment && CONVENTIONAL_VALIDATION_TASKS.includes(assignment[1] as typeof CONVENTIONAL_VALIDATION_TASKS[number])) {
          discovered.add(assignment[1] as typeof CONVENTIONAL_VALIDATION_TASKS[number]);
        }
      }
    }
  }
  try {
    for (const entry of await readdir(join(cwd, ".mise", "tasks"), { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const taskName = entry.name.replace(/\.[^.]+$/, "");
      if (CONVENTIONAL_VALIDATION_TASKS.includes(taskName as typeof CONVENTIONAL_VALIDATION_TASKS[number])) {
        discovered.add(taskName);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...discovered];
}

const defaultRepositoryIntake: RepositoryIntake = {
  async currentBranch(cwd) {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const branch = stdout.trim();
    if (!branch) throw new Error("The project is not on a named Git branch; check out the work to change first");
    return branch;
  },
  specificationSources: defaultSpecificationSources,
  miseTasks: defaultMiseTasks,
};

export function createNaturalImplementationInputResolver(
  repository: RepositoryIntake = defaultRepositoryIntake,
) {
  return async (request: string, cwd: string): Promise<ParsedProposedChangeInput> => {
    const instruction = request.trim();
    if (!instruction) throw new Error("Describe the change you want to make");

    const [namedBase, specSources, availableTasks] = await Promise.all([
      repository.currentBranch(cwd),
      repository.specificationSources(cwd),
      repository.miseTasks(cwd),
    ]);
    if (specSources.length === 0) {
      throw new Error("I could not find an approved specification for this project; the intended scope must be agreed first");
    }
    if (specSources.length > 1) {
      throw new Error("I found several specifications; say which feature or ticket this change belongs to");
    }
    const validationTasks = CONVENTIONAL_VALIDATION_TASKS.filter((task) => availableTasks.includes(task));
    if (validationTasks.length === 0) {
      throw new Error("This project has no standard validation task configured in mise (test, typecheck, lint, or check)");
    }

    return {
      namedBase,
      validationTasks,
      dependencyHosts: [],
      specSource: specSources[0],
      instruction,
    };
  };
}

export const resolveNaturalImplementationInput = createNaturalImplementationInputResolver();
