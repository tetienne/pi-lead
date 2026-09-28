import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { snapshotProjectResources } from "../src/context-snapshot.ts";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-snap-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".agents", "skills", "house-style"), { recursive: true });
  await mkdir(join(worktree, ".pi", "prompts"), { recursive: true });
  await writeFile(join(worktree, ".agents", "skills", "house-style", "SKILL.md"), "---\nname: house-style\n---\n");
  await writeFile(join(worktree, ".pi", "prompts", "fix.md"), "Fix it\n");
  await writeFile(join(worktree, ".pi", "APPEND_SYSTEM.md"), "Be terse.\n");
  // Skills shared by symlink, as skill installers do: a linked file and a linked skill directory.
  const shared = join(root, "shared");
  await mkdir(join(shared, "tdd"), { recursive: true });
  await writeFile(join(shared, "tdd", "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(shared, "tests.md"), "Test behaviour.\n");
  await symlink(join(shared, "tdd"), join(worktree, ".agents", "skills", "tdd"));
  await symlink(join(shared, "tests.md"), join(worktree, ".agents", "skills", "house-style", "tests.md"));
  await symlink(join(root, "gone.md"), join(worktree, ".agents", "skills", "house-style", "dangling.md"));
  // Larger than any budget the snapshot used to enforce.
  await writeFile(join(worktree, ".agents", "skills", "house-style", "reference.md"), "x".repeat(2 << 20));
  return { root, worktree };
}

test("trusted resources are copied out of the worktree, symlinked and large files included", async () => {
  const { root, worktree } = await repo();
  const resourceDir = join(root, "resources");
  const resources = await snapshotProjectResources({ worktreePath: worktree, resourceDir, projectTrusted: true });
  assert.deepEqual(resources.skills, [join(resourceDir, "agents-skills")]);
  assert.ok(existsSync(join(resourceDir, "agents-skills", "house-style", "SKILL.md")));
  const copied = join(resourceDir, "agents-skills");
  assert.equal(await readFile(join(copied, "tdd", "SKILL.md"), "utf8"), "---\nname: tdd\n---\n", "a linked skill directory");
  assert.equal(await readFile(join(copied, "house-style", "tests.md"), "utf8"), "Test behaviour.\n", "a linked file");
  assert.equal((await readFile(join(copied, "house-style", "reference.md"), "utf8")).length, 2 << 20);
  assert.ok(!existsSync(join(copied, "house-style", "dangling.md")), "a dangling link is skipped, not an error");
  assert.deepEqual(resources.prompts, [join(resourceDir, "prompts")]);
  assert.equal(await readFile(resources.appendSystem!, "utf8"), "Be terse.\n");
});

test("untrusted projects get no resources; Pi loads AGENTS.md from the worktree itself", async () => {
  const { root, worktree } = await repo();
  const resources = await snapshotProjectResources({ worktreePath: worktree, resourceDir: join(root, "res"), projectTrusted: false });
  assert.deepEqual(resources, { skills: [], prompts: [] });
  assert.ok(!existsSync(join(root, "res")), "nothing is written for an untrusted project");
});
