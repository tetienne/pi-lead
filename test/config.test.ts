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

test("removed settings in either file are ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs(
    { maxWorkers: 3, waitingTimeoutMinutes: 5, verify: "make check", jev: { via: "openrouter" }, tiers: { deep: { thinking: "xhigh" } } },
    { leadGuard: "off", verifyTimeoutMinutes: 9, jev: { minConfidence: 0.5 }, tiers: { fast: { thinking: "low" } }, stuckDetection: false },
  );
  const { config, ignored } = await loadConfig(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.deepEqual(config, { keepFailedWorkers: true, stuckDetection: false });
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
