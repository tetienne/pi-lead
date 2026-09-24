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
  const { agentDir, cwd } = await dirs({ leadGuard: "off", maxWorkers: 3 }, { verify: "npm test", maxWorkers: 4 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal(config.leadGuard, "off");
  assert.equal(config.verify, "npm test");
  assert.equal(config.maxWorkers, 4);

  const none = await dirs();
  assert.deepEqual((await loadConfigWithNotices(none.cwd, { projectTrusted: false, agentDir: none.agentDir })).ignored, []);
});

test("verify in the global config is dropped with a notice naming the file", async () => {
  const { agentDir, cwd } = await dirs({ verify: "make secret-target", maxWorkers: 3 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.equal(config.verify, undefined);
  assert.equal(config.maxWorkers, 3);
  assert.equal(ignored.length, 1);
  assert.equal(
    ignored[0],
    `PI Lead: \`verify\` in ${join(agentDir, "pi-lead.json")} is ignored; set it in the project's .pi/pi-lead.json.`,
  );
  assert.doesNotMatch(ignored[0]!, /secret-target/, "never the value");
});

test("a project file of an untrusted project is ignored with a notice on how to trust it", async () => {
  const { agentDir, cwd } = await dirs(undefined, { verify: "npm test", maxWorkers: 5 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: false, agentDir });
  assert.equal(config.verify, undefined);
  assert.equal(config.maxWorkers, 2);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0]!, /^PI Lead: \.pi\/pi-lead\.json is ignored because this project is not trusted in Pi \(.*\/trust.*--approve.*\)\.$/);
  assert.doesNotMatch(ignored[0]!, /npm test/);
});

test("leadGuard in the project file is dropped with a notice", async () => {
  const { agentDir, cwd } = await dirs(undefined, { leadGuard: "off", maxWorkers: 5 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.equal(config.leadGuard, "confirm");
  assert.equal(config.maxWorkers, 5);
  assert.deepEqual(ignored, ["PI Lead: `leadGuard` in .pi/pi-lead.json is ignored; only the global config can change it."]);
});

test("a config file that is not an object still loads without a notice", async () => {
  const { agentDir, cwd } = await dirs();
  await writeFile(join(agentDir, "pi-lead.json"), "5");
  assert.deepEqual((await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir })).ignored, []);
});
