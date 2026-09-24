import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { registerGitRead, validateGitReadArgs } from "../src/git-read.ts";

test("git_read accepts read-only git and disables external diff tools", () => {
  assert.deepEqual(validateGitReadArgs(["rev-parse", "pi-lead/x"]), { argv: ["rev-parse", "pi-lead/x"] });
  assert.deepEqual(validateGitReadArgs(["diff", "--stat", "main...pi-lead/x"]), {
    argv: ["diff", "--no-ext-diff", "--no-textconv", "--stat", "main...pi-lead/x"],
  });
  assert.deepEqual(validateGitReadArgs(["worktree", "list"]), { argv: ["worktree", "list"] });
  assert.deepEqual(validateGitReadArgs(["status", "--short"]), { argv: ["status", "--short"] });
  assert.deepEqual(validateGitReadArgs(["log", "--oneline"]), {
    argv: ["log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--oneline"],
  });
  assert.deepEqual(validateGitReadArgs(["show", "HEAD"]), {
    argv: ["show", "--no-ext-diff", "--no-textconv", "--no-show-signature", "HEAD"],
  });
  assert.ok("argv" in validateGitReadArgs(["status", "--porcelain"]));
  assert.ok("argv" in validateGitReadArgs(["status", "-sb"]));
  assert.ok("argv" in validateGitReadArgs(["log", "--oneline", "HEAD~3..HEAD", "--", "src/a.ts"]));
  assert.ok("argv" in validateGitReadArgs(["diff", "--text", "--output-indicator-new=>", "HEAD"]));
});

test("git_read refuses global options, writes, external programs and paths outside the repository", () => {
  for (const args of [
    ["-c", "x=y", "log"],
    ["-C", "/tmp", "log"],
    ["--git-dir=/tmp/x", "log"],
    ["diff", "--output=/tmp/x"],
    ["log", "--output", "/tmp/x"],
    ["diff", "--outp=/tmp/x"],
    ["diff", "--no-index", "/etc/passwd", "x"],
    ["diff", "/etc/passwd", "x"],
    ["diff", "HEAD", "--", "../secret"],
    ["show", "~/.ssh/id_rsa"],
    ["log", "--ext-diff"],
    ["show", "--textconv"],
    ["log", "-c"],
    ["log", "--stdin"],
    ["status", "-v"],
    ["status", "-vv"],
    ["status", "-sv"],
    ["status", "--verbose"],
    ["status", "--verb"],
    ["log", "--show-signature"],
    ["show", "--show-sig"],
    ["log", "--format=%G?"],
    ["log", "--pretty=tformat:%h %GS"],
    ["show", "--format", "%GK"],
    ["worktree", "add", "x"],
    ["worktree"],
    ["push"],
    ["config"],
    ["checkout"],
    [],
  ]) {
    assert.ok("error" in validateGitReadArgs(args), JSON.stringify(args));
  }
});

test("git_read runs in the Lead's repository and fails with git's message", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-lead-git-read-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

  let tool: any;
  registerGitRead({ registerTool: (registered: any) => (tool = registered) } as any);
  const run = (args: string[]) => tool.execute("t", { args }, undefined, undefined, { cwd: repo });

  const status = await run(["status", "--short"]);
  assert.match(status.content[0].text, /\?\? a\.txt/);
  const log = await run(["log", "--format=%s"]);
  assert.equal(log.content[0].text, "init\n");
  await assert.rejects(run(["push"]), /git_read refuses "push"/);
  await assert.rejects(run(["rev-parse", "refs/heads/missing"]), /failed:/);
});
