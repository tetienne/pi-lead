import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { createToolchains, toolchainKey } from "../src/toolchains.ts";

test("the cache key follows the project's mise configuration and the image", async () => {
  const clone = await mkdtemp(join(tmpdir(), "pi-lead-tc-"));
  assert.equal(await toolchainKey(clone, undefined), undefined, "no mise config, nothing to install");
  await writeFile(join(clone, "mise.toml"), '[tools]\nnode = "24"\n');
  const first = await toolchainKey(clone, undefined);
  assert.match(first!, /^[0-9a-f]{16}$/);
  assert.equal(await toolchainKey(clone, undefined), first);
  assert.notEqual(await toolchainKey(clone, "pi-lead:latest"), first);
  await writeFile(join(clone, ".tool-versions"), "python 3.13\n");
  assert.notEqual(await toolchainKey(clone, undefined), first);
  const withTools = await toolchainKey(clone, undefined);
  await symlink("/dev/zero", join(clone, ".mise.toml"));
  assert.equal(await toolchainKey(clone, undefined), withTools, "symlinked config files are ignored");
});

test("a warmed-up cache is reused without starting a VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-tc-root-"));
  const clone = await mkdtemp(join(tmpdir(), "pi-lead-tc-clone-"));
  await writeFile(join(clone, ".mise.toml"), '[tools]\ngo = "1.25"\n');
  const key = await toolchainKey(clone, DEFAULT_CONFIG.sandbox.image);
  const project = join(root, createHash("sha256").update("/repo").digest("hex").slice(0, 16));
  const cacheDir = join(project, key!);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(project, `${key}.ready`), "");
  const toolchains = createToolchains({ root, judge: { egress: async () => "deny" } });
  const progress: string[] = [];
  assert.equal(await toolchains.prepare({ repoRoot: "/repo", clonePath: clone, sandbox: DEFAULT_CONFIG.sandbox, progress: (t) => void progress.push(t) }), cacheDir);
  assert.deepEqual(progress, []);
  const empty = await mkdtemp(join(tmpdir(), "pi-lead-tc-empty-"));
  assert.equal(await toolchains.prepare({ repoRoot: "/repo", clonePath: empty, sandbox: DEFAULT_CONFIG.sandbox, progress: () => {} }), undefined);
});
