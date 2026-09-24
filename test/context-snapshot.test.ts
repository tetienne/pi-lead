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
  const secret = join(root, "secret.json");
  await writeFile(secret, "{\"token\":\"sk-live\"}");
  await symlink(secret, join(worktree, ".agents", "skills", "house-style", "leak.md"));
  return { root, worktree };
}

test("trusted resources are copied out of the worktree, never through symlinks", async () => {
  const { root, worktree } = await repo();
  const resourceDir = join(root, "resources");
  const resources = await snapshotProjectResources({ worktreePath: worktree, resourceDir, projectTrusted: true });
  assert.deepEqual(resources.skills, [join(resourceDir, "agents-skills")]);
  assert.ok(existsSync(join(resourceDir, "agents-skills", "house-style", "SKILL.md")));
  assert.ok(!existsSync(join(resourceDir, "agents-skills", "house-style", "leak.md")), "symlinks inside skills are skipped");
  assert.deepEqual(resources.prompts, [join(resourceDir, "prompts")]);
  assert.equal(await readFile(resources.appendSystem!, "utf8"), "Be terse.\n");
});

test("untrusted projects get no resources; Pi loads AGENTS.md from the worktree itself", async () => {
  const { root, worktree } = await repo();
  const resources = await snapshotProjectResources({ worktreePath: worktree, resourceDir: join(root, "res"), projectTrusted: false });
  assert.deepEqual(resources, { skills: [], prompts: [] });
  assert.ok(!existsSync(join(root, "res")), "nothing is written for an untrusted project");
});
