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
  const { agentDir, cwd } = await dirs({ leadGuard: "off" }, { verify: "npm test" });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal(config.leadGuard, "off");
  assert.equal(config.verify, "npm test");

  const none = await dirs();
  assert.deepEqual((await loadConfigWithNotices(none.cwd, { projectTrusted: false, agentDir: none.agentDir })).ignored, []);
});

test("an old maxWorkers key in a user file is ignored, no error and no notice", async () => {
  const { agentDir, cwd } = await dirs({ maxWorkers: 3 });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.deepEqual(ignored, []);
  assert.equal((config as { maxWorkers?: number }).maxWorkers, undefined);
});

test("verify in the global config is dropped with a notice naming the file", async () => {
  const { agentDir, cwd } = await dirs({ verify: "make secret-target" });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.equal(config.verify, undefined);
  assert.equal(ignored.length, 1);
  assert.equal(
    ignored[0],
    `PI Lead: \`verify\` in ${join(agentDir, "pi-lead.json")} is ignored; set it in the project's .pi/pi-lead.json.`,
  );
  assert.doesNotMatch(ignored[0]!, /secret-target/, "never the value");
});

test("a project file of an untrusted project is ignored with a notice on how to trust it", async () => {
  const { agentDir, cwd } = await dirs(undefined, { verify: "npm test" });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: false, agentDir });
  assert.equal(config.verify, undefined);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0]!, /^PI Lead: \.pi\/pi-lead\.json is ignored because this project is not trusted in Pi \(.*\/trust.*--approve.*\)\.$/);
  assert.doesNotMatch(ignored[0]!, /npm test/);
});

test("leadGuard in the project file is dropped with a notice", async () => {
  const { agentDir, cwd } = await dirs(undefined, { leadGuard: "off" });
  const { config, ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
  assert.equal(config.leadGuard, "confirm");
  assert.deepEqual(ignored, ["PI Lead: `leadGuard` in .pi/pi-lead.json is ignored; only the global config can change it."]);
});

test("a config file that is not an object still loads without a notice", async () => {
  const { agentDir, cwd } = await dirs();
  await writeFile(join(agentDir, "pi-lead.json"), "5");
  assert.deepEqual((await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir })).ignored, []);
});

test("a notice shows a path under the home directory with ~", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-lead-config-home-"));
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "pi-lead.json"), JSON.stringify({ verify: "npm test" }));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { cwd } = await dirs();
    const { ignored } = await loadConfigWithNotices(cwd, { projectTrusted: true, agentDir });
    assert.deepEqual(ignored, ["PI Lead: `verify` in ~/.pi/agent/pi-lead.json is ignored; set it in the project's .pi/pi-lead.json."]);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});
