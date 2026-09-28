import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfigWithNotices } from "../src/config.ts";

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
  const { agentDir, cwd } = await dirs({ keepFailedWorkers: false }, { waitingTimeoutMinutes: 30 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal(config.keepFailedWorkers, false);
  assert.equal(config.waitingTimeoutMinutes, 30);

  const none = await dirs();
  assert.deepEqual((await loadConfigWithNotices(none.cwd, { projectTrusted: false, agentDir: none.agentDir })).ignored, []);
});

test("an old maxWorkers key in a user file is ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs({ maxWorkers: 3 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal((config as { maxWorkers?: number }).maxWorkers, undefined);
});

test("a project file of an untrusted project is ignored with a notice on how to trust it", async () => {
  const { agentDir, cwd } = await dirs(undefined, { waitingTimeoutMinutes: 5 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: false, agentDir });
  assert.equal(config.waitingTimeoutMinutes, 120);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0]!, /^PI Lead: \.pi\/pi-lead\.json is ignored because this project is not trusted in Pi \(.*\/trust.*--approve.*\)\.$/);
  assert.doesNotMatch(ignored[0]!, /waitingTimeoutMinutes/);
});

test("a config file that is not an object still loads without a notice", async () => {
  const { agentDir, cwd } = await dirs();
  await writeFile(join(agentDir, "pi-lead.json"), "5");
  assert.deepEqual((await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir })).ignored, []);
});

test("tiers.review is optional, inherits the standard thinking level, and a project file layers on the global one", async () => {
  const none = await dirs();
  assert.equal((await loadConfigWithNotices(none.cwd, { projectTrusted: true, agentDir: none.agentDir })).config.tiers.review, undefined);
  const { agentDir, cwd } = await dirs(
    { tiers: { standard: { thinking: "high" }, review: { model: "opencode-go/deepseek-v4.1-flash", fallbacks: [{ model: "a/b" }] } } },
    { tiers: { review: { thinking: "low" } } },
  );
  const { config } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(config.tiers.review, { model: "opencode-go/deepseek-v4.1-flash", thinking: "low", fallbacks: [{ model: "a/b" }] });
  const inherited = await dirs({ tiers: { standard: { thinking: "high" }, review: { model: "a/b" } } });
  assert.equal((await loadConfigWithNotices(inherited.cwd, { projectTrusted: true, agentDir: inherited.agentDir })).config.tiers.review?.thinking, "high");
});
