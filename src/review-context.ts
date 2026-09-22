import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type PinnedReviewDocument = {
  source: string;
  digest: string;
  contents: string;
};

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

async function readConfinedFile(root: string, source: string, maxBytes: number): Promise<string> {
  if (
    !source ||
    isAbsolute(source) ||
    source.includes("\0") ||
    source.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error("Review source must be a confined relative file");
  }
  const candidate = resolve(root, source);
  if (!isWithin(root, candidate)) throw new Error("Review source escapes the consuming project");
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`Review source must be a regular file of at most ${maxBytes} bytes: ${source}`);
  }
  const contents = await readFile(candidate, "utf8");
  if (!contents.trim()) throw new Error(`Review source is empty: ${source}`);
  return contents;
}

function pinned(source: string, contents: string): PinnedReviewDocument {
  return {
    source,
    digest: createHash("sha256").update(contents, "utf8").digest("hex"),
    contents,
  };
}

export async function pinReviewSpecification(cwd: string, source: string): Promise<PinnedReviewDocument> {
  const root = await realpath(cwd);
  return pinned(source, await readConfinedFile(root, source, 32 * 1024));
}

export async function pinReviewStandards(cwd: string): Promise<PinnedReviewDocument> {
  const root = await realpath(cwd);
  const candidates = [
    "AGENTS.md",
    "CONSTRAINTS.md",
    "CODING_STANDARDS.md",
    "CONTRIBUTING.md",
    "CONTEXT.md",
    "docs/security-rules.md",
    "docs/agents/issue-tracker.md",
    "docs/agents/domain.md",
    "docs/planning/matt-workflow.md",
    ".agents/skills/implement/SKILL.md",
    ".agents/skills/tdd/SKILL.md",
    ".agents/skills/code-review/SKILL.md",
  ];
  for (const directory of ["docs/adr", "docs/decisions"] as const) {
    try {
      for (const entry of await readdir(resolve(root, directory))) {
        if (entry.endsWith(".md")) candidates.push(`${directory}/${entry}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    }
  }
  const documents: string[] = [];
  for (const source of candidates) {
    try {
      documents.push(`--- ${source} ---\n${await readConfinedFile(root, source, 32 * 1024)}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) continue;
      throw error;
    }
  }
  if (documents.length === 0) {
    throw new Error("No repository standards source is available for independent review");
  }
  return pinned(documents.map((document) => document.match(/^--- (.+) ---/)?.[1]).join(","), documents.join("\n\n"));
}
