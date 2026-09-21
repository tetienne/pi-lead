import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { prepareChatGptQuestion } from "../src/chatgpt-input.ts";

test("explicit project inputs are bounded and embedded in the worker question", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lead-input-"));
  await writeFile(join(cwd, "CONTEXT.md"), "Lead: the persistent coordinator.\n", "utf8");
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "docs", "decision.md"), "Workers are isolated.\n", "utf8");

  const question = await prepareChatGptQuestion(
    "--inputs CONTEXT.md,docs/decision.md -- What is Lead?",
    cwd,
  );

  assert.match(question, /What is Lead\?/);
  assert.match(question, /BEGIN PROJECT INPUT: CONTEXT\.md/);
  assert.match(question, /Lead: the persistent coordinator\./);
  assert.match(question, /BEGIN PROJECT INPUT: docs\/decision\.md/);
  assert.match(question, /Workers are isolated\./);
});

test("project input selection rejects traversal, symlinks, and oversized direct questions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lead-input-"));
  await writeFile(join(cwd, "inside.md"), "safe\n", "utf8");
  await symlink("/etc/hosts", join(cwd, "outside.md"));

  await assert.rejects(
    prepareChatGptQuestion("--inputs ../secret -- summarize", cwd),
    /relative project path/i,
  );
  await assert.rejects(
    prepareChatGptQuestion("--inputs outside.md -- summarize", cwd),
    /symbolic links/i,
  );
  await assert.rejects(prepareChatGptQuestion("x".repeat(4_001), cwd), /1–4000 characters/i);
});
