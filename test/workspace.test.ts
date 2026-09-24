import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitWorkspace } from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("a worker clone is disposable and its branch comes back by fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-ws-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "feature");

  const clone = join(root, "clone");
  const { base } = await gitWorkspace.create({ repoRoot: repo, path: clone, branch: "pi-lead/x-1" });
  assert.equal(base, git(repo, "rev-parse", "HEAD"));
  assert.equal(git(clone, "remote", "get-url", "origin"), "file:///nonexistent");
  assert.match(git(clone, "branch", "-r"), /origin\/feature/);

  // What the guest does inside the VM.
  await writeFile(join(clone, "a.txt"), "two\n");
  git(clone, "commit", "-qam", "change");

  const collected = await gitWorkspace.collect({ repoRoot: repo, path: clone, branch: "pi-lead/x-1", base });
  assert.match(collected.commits, /change/);
  assert.match(collected.diffStat, /a\.txt/);
  assert.deepEqual(collected.changedFiles, ["a.txt"]);
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: base, path: "a.txt" }), "one");
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: "pi-lead/x-1", path: "a.txt" }), "two");
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: base, path: "missing.json" }), undefined);
  assert.equal(collected.head, git(clone, "rev-parse", "HEAD"));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the user's checkout is untouched");
  assert.equal(git(repo, "log", "-1", "--format=%s", "pi-lead/x-1"), "change");

  await gitWorkspace.remove(clone);
  const review = join(root, "review");
  await gitWorkspace.create({ repoRoot: repo, path: review, branch: "pi-lead/r-1", startFrom: "feature" });
  assert.equal(git(review, "rev-parse", "HEAD"), git(repo, "rev-parse", "feature"));
});
