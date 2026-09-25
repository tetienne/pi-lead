import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyChecks, gitWorkspace, readChecks } from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("classifyChecks: fail/cancel win over pending; pass only when every bucket is pass or skipping", () => {
  assert.deepEqual(
    classifyChecks([{ name: "a", bucket: "pass", link: "" }, { name: "b", bucket: "skipping", link: "" }]),
    { state: "pass", failed: [] },
  );
  assert.deepEqual(
    classifyChecks([{ name: "a", bucket: "pass", link: "" }, { name: "b", bucket: "pending", link: "" }]),
    { state: "pending", failed: [] },
  );
  assert.deepEqual(
    classifyChecks([{ name: "a", bucket: "pending", link: "" }, { name: "b", bucket: "fail", link: "https://x" }]),
    { state: "fail", failed: [{ name: "b", link: "https://x" }] },
  );
  assert.deepEqual(
    classifyChecks([{ name: "c", bucket: "cancel", link: "https://y" }]),
    { state: "fail", failed: [{ name: "c", link: "https://y" }] },
  );
});

test("readChecks: JSON even on a non-zero exit; only gh's own message means no checks; any other failure is error", () => {
  const failing = JSON.stringify([{ name: "ci", bucket: "fail", link: "https://x" }]);
  assert.deepEqual(readChecks({ stdout: failing, error: new Error("exit 1") }), { state: "fail", failed: [{ name: "ci", link: "https://x" }] });
  assert.deepEqual(readChecks({ stdout: "[]" }), { state: "none", failed: [] });
  assert.deepEqual(readChecks({ stdout: "", stderr: "no checks reported on the 'x' branch", error: new Error("exit 1") }), { state: "none", failed: [] });
  assert.deepEqual(readChecks({ stderr: "gh: To get started with GitHub CLI, please run: gh auth login\nmore", error: new Error("exit 4") }), {
    state: "error",
    failed: [],
    error: "gh: To get started with GitHub CLI, please run: gh auth login",
  });
  assert.equal(readChecks({ error: new Error("spawn gh ENOENT") }).error, "spawn gh ENOENT");
  assert.equal(readChecks({ stdout: "not json" }).state, "error");
});

test("a worker's branch and commits are visible from the repo through its worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-ws-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "feature");

  const base = await gitWorkspace.resolveBase({ repoRoot: repo });
  assert.equal(base, git(repo, "rev-parse", "HEAD"));

  // What Herdr does: add a linked worktree on a new branch from `base`.
  const worktree = join(root, "worktree");
  git(repo, "worktree", "add", "-q", "-b", "pi-lead/x-1", worktree, base);

  // What the worker does inside its worktree.
  await writeFile(join(worktree, "a.txt"), "two\n");
  git(worktree, "commit", "-qam", "change");

  const collected = await gitWorkspace.collect({ repoRoot: repo, branch: "pi-lead/x-1", base });
  assert.match(collected.commits, /change/);
  assert.match(collected.diffStat, /a\.txt/);
  assert.deepEqual(collected.changedFiles, ["a.txt"]);
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: base, path: "a.txt" }), "one");
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: "pi-lead/x-1", path: "a.txt" }), "two");
  assert.equal(await gitWorkspace.fileAt({ repoRoot: repo, rev: base, path: "missing.json" }), undefined);
  assert.equal(collected.head, git(worktree, "rev-parse", "HEAD"));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the user's checkout is untouched");
  assert.equal(git(repo, "log", "-1", "--format=%s", "pi-lead/x-1"), "change");

  git(repo, "worktree", "remove", "--force", worktree);
  const reviewBase = await gitWorkspace.resolveBase({ repoRoot: repo, startFrom: "feature" });
  assert.equal(reviewBase, git(repo, "rev-parse", "feature"));

  await gitWorkspace.remove(root);
  await assert.rejects(readFile(join(repo, "a.txt")));
});

test("mainCheckout resolves a linked worktree back to the main repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-lead-ws-main-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  const worktree = join(await mkdtemp(join(tmpdir(), "pi-lead-ws-linked-")), "wt");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

  assert.equal(await realpath(await gitWorkspace.mainCheckout(worktree)), await realpath(repo));
  assert.equal(await realpath(await gitWorkspace.mainCheckout(repo)), await realpath(repo), "already the main checkout");
});

test("currentBranch reports the checkout's branch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-lead-ws-added-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "src.ts"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  git(repo, "checkout", "-qb", "feature");
  assert.equal(await gitWorkspace.currentBranch(repo), "feature");
});
