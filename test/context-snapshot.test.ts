import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { snapshotProjectResources } from "../src/context-snapshot.ts";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-snap-"));
  const clone = join(root, "repo");
  await mkdir(join(clone, ".agents", "skills", "house-style"), { recursive: true });
  await mkdir(join(clone, ".pi", "prompts"), { recursive: true });
  await writeFile(join(clone, "AGENTS.md"), "Use tabs.\n");
  await writeFile(join(clone, ".agents", "skills", "house-style", "SKILL.md"), "---\nname: house-style\n---\n");
  await writeFile(join(clone, ".pi", "prompts", "fix.md"), "Fix it\n");
  await writeFile(join(clone, ".pi", "APPEND_SYSTEM.md"), "Be terse.\n");
  const secret = join(root, "secret.json");
  await writeFile(secret, "{\"token\":\"sk-live\"}");
  await symlink(secret, join(clone, "CLAUDE.md"));
  await symlink(secret, join(clone, ".agents", "skills", "house-style", "leak.md"));
  return { root, clone };
}

test("context files and trusted resources are copied out of the clone, never through symlinks", async () => {
  const { root, clone } = await repo();
  const workDir = join(root, "cwd");
  const resourceDir = join(root, "resources");
  const resources = await snapshotProjectResources({ clonePath: clone, workDir, resourceDir, projectTrusted: true });
  assert.equal(await readFile(join(workDir, "AGENTS.md"), "utf8"), "Use tabs.\n");
  assert.ok(!existsSync(join(workDir, "CLAUDE.md")), "a symlinked context file is skipped");
  assert.deepEqual(resources.skills, [join(resourceDir, "agents-skills")]);
  assert.ok(existsSync(join(resourceDir, "agents-skills", "house-style", "SKILL.md")));
  assert.ok(!existsSync(join(resourceDir, "agents-skills", "house-style", "leak.md")), "symlinks inside skills are skipped");
  assert.deepEqual(resources.prompts, [join(resourceDir, "prompts")]);
  assert.equal(await readFile(resources.appendSystem!, "utf8"), "Be terse.\n");
});

test("untrusted projects only get their context files, as Pi loads them regardless of trust", async () => {
  const { root, clone } = await repo();
  const resources = await snapshotProjectResources({ clonePath: clone, workDir: join(root, "cwd"), resourceDir: join(root, "res"), projectTrusted: false });
  assert.deepEqual(resources, { skills: [], prompts: [] });
  assert.ok(existsSync(join(root, "cwd", "AGENTS.md")));
});
