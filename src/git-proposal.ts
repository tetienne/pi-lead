import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import type { ProposedFile } from "./proposed-change-task.ts";

export const PROPOSAL_REF = "refs/heads/pi-lead-proposal";
const TRUSTED_GIT = "/usr/bin/git";
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_CHANGED_FILES = 1_000;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NAMED_BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

type GitOutput = { stdout: Buffer; stderr: Buffer };

function safeGitEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    HOME: cwd,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  maxBuffer = 8 * 1024 * 1024,
): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      TRUSTED_GIT,
      [
        "--no-pager",
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd,
        encoding: "buffer",
        env: safeGitEnvironment(cwd),
        maxBuffer,
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.from(stderr).toString("utf8").trim();
          reject(new Error(`Trusted Git operation failed: ${detail || error.message}`, { cause: error }));
          return;
        }
        resolvePromise({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
      },
    );
  });
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit(cwd, args)).stdout.toString("utf8").trim();
}

function requireNamedBase(namedBase: string): void {
  if (
    !NAMED_BASE.test(namedBase) ||
    namedBase.includes("..") ||
    namedBase.includes("@{") ||
    namedBase.includes("//") ||
    namedBase.endsWith(".") ||
    namedBase.endsWith("/") ||
    namedBase.endsWith(".lock") ||
    namedBase === "HEAD" ||
    namedBase.startsWith("refs/")
  ) {
    throw new Error(`Invalid named Git base: ${namedBase}`);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function prepareCommittedBase(options: {
  repositoryPath: string;
  namedBase: string;
  outputPath: string;
}): Promise<{ namedBase: string; baseCommit: string; bundlePath: string }> {
  requireNamedBase(options.namedBase);
  const repositoryPath = await realpath(options.repositoryPath);
  const topLevel = await gitText(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const bundlePath = resolve(options.outputPath);
  if (isInside(resolve(topLevel), bundlePath)) {
    throw new Error("The base bundle must be stored outside the consuming-project checkout");
  }
  const baseCommit = await gitText(repositoryPath, [
    "rev-parse",
    "--verify",
    `${options.namedBase}^{commit}`,
  ]);
  if (!OBJECT_ID.test(baseCommit)) throw new Error("Named base did not resolve to a commit");
  const fullRef = await gitText(repositoryPath, [
    "rev-parse",
    "--symbolic-full-name",
    options.namedBase,
  ]);
  if (!fullRef.startsWith("refs/")) {
    throw new Error("The committed base must be identified by a branch or tag name");
  }
  await mkdir(dirname(bundlePath), { recursive: true, mode: 0o700 });
  await runGit(repositoryPath, ["bundle", "create", bundlePath, fullRef]);
  return { namedBase: options.namedBase, baseCommit, bundlePath };
}

function decodePath(value: Buffer): string {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("Proposed Git path is not valid UTF-8");
  }
  if (
    value.byteLength === 0 ||
    value.byteLength > 4_096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`Proposed path escapes the workspace: ${JSON.stringify(path)}`);
  }
  return path;
}

function splitNull(buffer: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error("Git emitted an unterminated raw diff record");
  return fields;
}

type RawChange = {
  oldMode: string;
  newMode: string;
  oldObject: string;
  newObject: string;
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
  previousPath?: string;
};

function parseRawChanges(output: Buffer): RawChange[] {
  const fields = splitNull(output);
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++]?.toString("ascii") ?? "";
    if (!header) continue;
    const match =
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([AMDRT])(\d*)$/.exec(
        header,
      );
    if (!match) throw new Error(`Unsupported Git change record: ${header}`);
    const [, oldMode, newMode, oldObject, newObject, code] = match;
    const firstPath = fields[index++];
    if (!firstPath || !oldMode || !newMode || !oldObject || !newObject || !code) {
      throw new Error("Incomplete Git change record");
    }
    if (code === "R") {
      const secondPath = fields[index++];
      if (!secondPath) throw new Error("Incomplete Git rename record");
      changes.push({
        oldMode,
        newMode,
        oldObject,
        newObject,
        status: "renamed",
        previousPath: decodePath(firstPath),
        path: decodePath(secondPath),
      });
      continue;
    }
    changes.push({
      oldMode,
      newMode,
      oldObject,
      newObject,
      status:
        code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      path: decodePath(firstPath),
    });
  }
  if (changes.length > MAX_CHANGED_FILES) {
    throw new Error(`Proposed change exceeds ${MAX_CHANGED_FILES} files`);
  }
  return changes;
}

function isBinary(content: Buffer): boolean {
  if (content.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}

function decodeSymlinkTarget(path: string, content: Buffer): string {
  let target: string;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Symlink target is not valid UTF-8: ${path}`);
  }
  if (!target) throw new Error(`Symlink target escapes the workspace: ${path} -> ${target}`);
  return target;
}

function confinedPath(path: string, target: string, candidate: string): string {
  const normalized = posix.normalize(candidate);
  if (posix.isAbsolute(target) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Symlink target escapes the workspace: ${path} -> ${target}`);
  }
  return normalized;
}

function requireConfinedSymlink(
  path: string,
  target: string,
  symlinks: ReadonlyMap<string, string>,
): void {
  let resolved = confinedPath(path, target, posix.join(posix.dirname(path), target));
  const visited = new Set<string>();
  while (true) {
    const parts = resolved.split("/").filter((part) => part && part !== ".");
    let prefix = "";
    let followed = false;
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : (parts[index] ?? "");
      const nestedTarget = symlinks.get(prefix);
      if (nestedTarget === undefined) continue;
      if (visited.has(prefix)) {
        throw new Error(`Symlink target cycle is not confined: ${path} -> ${target}`);
      }
      visited.add(prefix);
      const suffix = parts.slice(index + 1).join("/");
      resolved = confinedPath(
        path,
        nestedTarget,
        posix.join(posix.dirname(prefix), nestedTarget, suffix),
      );
      followed = true;
      break;
    }
    if (!followed) return;
  }
}

async function proposedSymlinks(
  repository: string,
  proposedCommit: string,
): Promise<Map<string, string>> {
  const tree = await runGit(repository, ["ls-tree", "-r", "-z", "--full-tree", proposedCommit]);
  const symlinks = new Map<string, string>();
  for (const entry of splitNull(tree.stdout)) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf(9);
    if (separator < 0) throw new Error("Invalid proposed tree record");
    const metadata = entry.subarray(0, separator).toString("ascii").split(" ");
    const [mode, type, object] = metadata;
    if (mode !== "120000") continue;
    if (type !== "blob" || !object || !OBJECT_ID.test(object)) {
      throw new Error("Invalid proposed symlink object");
    }
    const path = decodePath(entry.subarray(separator + 1));
    const size = Number(await gitText(repository, ["cat-file", "-s", object]));
    if (!Number.isSafeInteger(size) || size < 1 || size > 4_096) {
      throw new Error(`Invalid proposed symlink target size: ${path}`);
    }
    const content = await runGit(repository, ["cat-file", "blob", object], 8_192);
    symlinks.set(path, decodeSymlinkTarget(path, content.stdout));
  }
  return symlinks;
}

async function objectContents(repository: string, object: string): Promise<Buffer> {
  if (!OBJECT_ID.test(object)) throw new Error("Invalid proposed object ID");
  const sizeText = await gitText(repository, ["cat-file", "-s", object]);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES) {
    throw new Error(`Proposed blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  const output = await runGit(repository, ["cat-file", "blob", object], MAX_BLOB_BYTES + 1024);
  if (output.stdout.byteLength !== size) throw new Error("Proposed blob size changed during collection");
  return output.stdout;
}

async function assertProposalParent(
  repository: string,
  baseCommit: string,
  proposedCommit: string,
): Promise<void> {
  const type = await gitText(repository, ["cat-file", "-t", proposedCommit]);
  if (type !== "commit") throw new Error("Proposed ref does not identify a commit");
  const commit = await gitText(repository, ["cat-file", "-p", proposedCommit]);
  const parents = commit
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
  if (parents.length !== 1 || parents[0] !== baseCommit) {
    throw new Error("Proposed commit is not based directly on the named base");
  }
}

export async function collectGitProposal(options: {
  baseCommit: string;
  bundlePath: string;
  collectionDirectory: string;
}): Promise<{
  artifactId: string;
  proposedCommit: string;
  files: readonly ProposedFile[];
}> {
  if (!OBJECT_ID.test(options.baseCommit)) throw new Error("Invalid base commit ID");
  const bundlePath = resolve(options.bundlePath);
  const bundleMetadata = await lstat(bundlePath);
  if (!bundleMetadata.isFile() || bundleMetadata.isSymbolicLink()) {
    throw new Error("Proposal bundle must be a regular host-owned file");
  }
  if (bundleMetadata.size <= 0 || bundleMetadata.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Proposal bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  await mkdir(options.collectionDirectory, { recursive: true, mode: 0o700 });
  const inspectionRoot = await mkdtemp(resolve(options.collectionDirectory, "inspection-"));
  const repository = resolve(inspectionRoot, "objects.git");
  const template = resolve(inspectionRoot, "empty-template");
  await mkdir(template, { mode: 0o700 });
  await runGit(inspectionRoot, ["-c", `init.templateDir=${template}`, "init", "--bare", repository]);
  await runGit(repository, ["bundle", "verify", bundlePath]);
  const heads = await gitText(repository, ["bundle", "list-heads", bundlePath, PROPOSAL_REF]);
  const headLines = heads.split("\n").filter(Boolean);
  if (headLines.length !== 1) throw new Error("Proposal bundle has no unique proposal ref");
  const [proposedCommit, ref, ...extra] = headLines[0]?.split(" ") ?? [];
  if (!proposedCommit || ref !== PROPOSAL_REF || extra.length > 0 || !OBJECT_ID.test(proposedCommit)) {
    throw new Error("Proposal bundle has an invalid proposal ref");
  }
  await runGit(repository, ["bundle", "unbundle", bundlePath]);
  const baseType = await gitText(repository, ["cat-file", "-t", options.baseCommit]);
  if (baseType !== "commit") throw new Error("Named base commit is absent from the proposal bundle");
  await assertProposalParent(repository, options.baseCommit, proposedCommit);
  const diff = await runGit(repository, [
    "diff-tree",
    "-r",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-commit-id",
    "--find-renames",
    options.baseCommit,
    proposedCommit,
  ]);
  const rawChanges = parseRawChanges(diff.stdout);
  const symlinks = await proposedSymlinks(repository, proposedCommit);
  const files: ProposedFile[] = [];
  let totalBlobBytes = 0;
  for (const change of rawChanges) {
    if (change.status === "deleted") {
      files.push({
        path: change.path,
        status: change.status,
        oldMode: change.oldMode,
        newMode: change.newMode,
      });
      continue;
    }
    if (!["100644", "100755", "120000"].includes(change.newMode)) {
      throw new Error(`Unsupported proposed file mode ${change.newMode}: ${change.path}`);
    }
    const content = await objectContents(repository, change.newObject);
    totalBlobBytes += content.byteLength;
    if (totalBlobBytes > MAX_TOTAL_BLOB_BYTES) {
      throw new Error(`Proposed file content exceeds ${MAX_TOTAL_BLOB_BYTES} bytes`);
    }
    const symlinkTarget =
      change.newMode === "120000" ? decodeSymlinkTarget(change.path, content) : undefined;
    if (symlinkTarget !== undefined) {
      requireConfinedSymlink(change.path, symlinkTarget, symlinks);
    }
    files.push({
      path: change.path,
      ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
      status: change.status,
      oldMode: change.oldMode,
      newMode: change.newMode,
      contentBase64: content.toString("base64"),
      binary: change.newMode === "120000" ? false : isBinary(content),
      ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
    });
  }
  const artifactId = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
  return { artifactId, proposedCommit, files };
}
