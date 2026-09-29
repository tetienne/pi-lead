import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";

async function dirs(global?: object, project?: object) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-lead-config-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-lead-config-project-"));
  if (global) await writeFile(join(agentDir, "pi-lead.json"), JSON.stringify(global));
  if (project) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "pi-lead.json"), JSON.stringify(project));
  }
  return { agentDir, cwd };
}

test("settings in their right place produce no notice", async () => {
  const { agentDir, cwd } = await dirs({ keepFailedWorkers: false }, { stuckDetection: false });
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal(config.keepFailedWorkers, false);
  assert.equal(config.stuckDetection, false);

  const none = await dirs();
  assert.deepEqual((await loadConfig(none.cwd, { projectTrusted: false, agentDir: none.agentDir })).ignored, []);
});

test("an old maxWorkers, leadGuard or waitingTimeoutMinutes key in a user file is ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs({ maxWorkers: 3, waitingTimeoutMinutes: 5 }, { leadGuard: "off" });
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal((config as { maxWorkers?: number }).maxWorkers, undefined);
  assert.equal((config as { leadGuard?: string }).leadGuard, undefined);
  assert.equal((config as { waitingTimeoutMinutes?: number }).waitingTimeoutMinutes, undefined);
});

test("reviewModel is kept when a non-empty string and dropped otherwise", async () => {
  const kept = await dirs({ reviewModel: " openai-codex/gpt-6-astra:high " });
  assert.equal((await loadConfig(kept.cwd, { projectTrusted: true, agentDir: kept.agentDir })).config.reviewModel, "openai-codex/gpt-6-astra:high");
  for (const bad of [42, "  ", null, ["a"]]) {
    const { agentDir, cwd } = await dirs({ reviewModel: bad });
    assert.equal((await loadConfig(cwd, { projectTrusted: true, agentDir })).config.reviewModel, undefined);
  }
});

test("old jev and tiers blocks in either file are ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs(
    { jev: { via: "openrouter", model: "jev-2", dailyBudgetUsd: 0.5 }, tiers: { deep: { model: "openai-codex/gpt-6-astra", thinking: "xhigh" } } },
    { jev: { minConfidence: 0.5 }, tiers: { fast: { thinking: "low" } }, stuckDetection: false },
  );
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.deepEqual(config, { keepFailedWorkers: true, stuckDetection: false });
});

test("old verify and verifyTimeoutMinutes keys in either file are ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs({ verify: "make check", verifyTimeoutMinutes: 5 }, { verify: "npm test", verifyTimeoutMinutes: 9 });
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal((config as { verify?: string }).verify, undefined);
  assert.equal((config as { verifyTimeoutMinutes?: number }).verifyTimeoutMinutes, undefined);
});

test("a project file of an untrusted project is ignored with a notice on how to trust it", async () => {
  const { agentDir, cwd } = await dirs(undefined, { keepFailedWorkers: false });
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: false, agentDir });
  assert.equal(config.keepFailedWorkers, true);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0]!, /^PI Lead: \.pi\/pi-lead\.json is ignored because this project is not trusted in Pi \(.*\/trust.*--approve.*\)\.$/);
});

test("a config file that is not an object still loads without a notice", async () => {
  const { agentDir, cwd } = await dirs();
  await writeFile(join(agentDir, "pi-lead.json"), "5");
  assert.deepEqual((await loadConfig(cwd, { projectTrusted: true, agentDir })).ignored, []);
});
