import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ParsedProposedChangeInput } from "./proposed-change-input.ts";
import { pinReviewText, type PinnedReviewDocument } from "./review-context.ts";

const execFileAsync = promisify(execFile);
const CONVENTIONAL_VALIDATION_TASKS = ["test", "typecheck", "lint", "check"] as const;

type GitHubTicket = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: readonly string[];
  blockedBy: number;
  repository: string;
};

type RepositoryIntake = {
  currentBranch(cwd: string): Promise<string>;
  specificationSources(cwd: string): Promise<readonly string[]>;
  miseTasks(cwd: string): Promise<readonly string[]>;
  githubTicketSpecification?(cwd: string, ticketNumber: number | undefined): Promise<PinnedReviewDocument | undefined>;
};

export type ResolvedImplementationInput = ParsedProposedChangeInput & {
  pinnedSpecification?: PinnedReviewDocument;
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

function ticketNumberFrom(request: string): number | undefined {
  const numbers = new Set<number>();
  for (const match of request.matchAll(/(?:#|\b(?:ticket|issue)\s+#?)(\d{1,9})\b/gi)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) numbers.add(value);
  }
  if (numbers.size > 1) {
    throw new Error("I found several ticket references; say which approved ticket to implement");
  }
  return [...numbers][0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function gitHubRepository(remote: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}/${match[2]}`;
}

function parseGitHubTicket(value: unknown, repository: string): GitHubTicket {
  if (!isRecord(value)) throw new Error("GitHub returned an invalid ticket record");
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : [])
    : [];
  const summary = isRecord(value.issue_dependencies_summary) ? value.issue_dependencies_summary : {};
  const number = value.number;
  const blockedBy = summary.total_blocked_by;
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 ||
    typeof value.title !== "string" || typeof value.body !== "string" || typeof value.state !== "string" ||
    (blockedBy !== undefined && (typeof blockedBy !== "number" || !Number.isSafeInteger(blockedBy) || blockedBy < 0))
  ) {
    throw new Error("GitHub returned an invalid ticket record");
  }
  return {
    number,
    title: value.title,
    body: value.body,
    state: value.state,
    labels,
    blockedBy: typeof blockedBy === "number" ? blockedBy : 0,
    repository,
  };
}

async function defaultGitHubTicketSpecification(
  cwd: string,
  ticketNumber: number | undefined,
): Promise<PinnedReviewDocument | undefined> {
  const tracker = await readBoundedRegularFile(join(cwd, "docs", "agents", "issue-tracker.md"), 64 * 1024);
  if (!/(?:^|\n)\s*#\s*issue tracker\s*:\s*github\s*$/im.test(tracker ?? "")) return undefined;
  if (ticketNumber === undefined) {
    throw new Error("This project tracks approved scope in GitHub; name the ready-for-agent ticket to implement");
  }
  const { stdout: remote } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  const repository = gitHubRepository(remote);
  if (!repository) throw new Error("The consuming project has no GitHub origin configured for ticket lookup");
  let response: unknown;
  try {
    const { stdout } = await execFileAsync("gh", ["api", `repos/${repository}/issues/${ticketNumber}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
    response = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`I could not read GitHub ticket #${ticketNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ticket = parseGitHubTicket(response, repository);
  if (ticket.state.toUpperCase() !== "OPEN") {
    throw new Error(`GitHub ticket #${ticket.number} is not open`);
  }
  if (!ticket.labels.includes("ready-for-agent")) {
    throw new Error(`GitHub ticket #${ticket.number} is not approved for an agent (missing ready-for-agent)`);
  }
  if (ticket.blockedBy > 0) {
    throw new Error(`GitHub ticket #${ticket.number} is blocked by ${ticket.blockedBy} open ticket${ticket.blockedBy === 1 ? "" : "s"}`);
  }
  return pinReviewText(
    `github:${ticket.repository}#${ticket.number}`,
    `# ${ticket.number}: ${ticket.title}\n\n${ticket.body}`,
  );
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
  githubTicketSpecification: defaultGitHubTicketSpecification,
};

export function createNaturalImplementationInputResolver(
  repository: RepositoryIntake = defaultRepositoryIntake,
) {
  return async (request: string, cwd: string): Promise<ResolvedImplementationInput> => {
    const instruction = request.trim();
    if (!instruction) throw new Error("Describe the change you want to make");
    const ticketNumber = ticketNumberFrom(instruction);

    const [namedBase, specSources, availableTasks, githubSpecification] = await Promise.all([
      repository.currentBranch(cwd),
      repository.specificationSources(cwd),
      repository.miseTasks(cwd),
      repository.githubTicketSpecification?.(cwd, ticketNumber),
    ]);
    const validationTasks = CONVENTIONAL_VALIDATION_TASKS.filter((task) => availableTasks.includes(task));
    if (validationTasks.length === 0) {
      throw new Error("This project has no standard validation task configured in mise (test, typecheck, lint, or check)");
    }
    if (githubSpecification) {
      return {
        namedBase,
        validationTasks,
        dependencyHosts: [],
        instruction,
        pinnedSpecification: githubSpecification,
      };
    }
    if (specSources.length === 0) {
      throw new Error("I could not find an approved specification for this project; the intended scope must be agreed first");
    }
    if (specSources.length > 1) {
      throw new Error("I found several specifications; say which feature or ticket this change belongs to");
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
