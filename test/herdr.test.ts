import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHerdrCli, workspaceFromPaneId } from "../src/herdr.ts";

/** A fake `herdr` on PATH that logs its argv and refuses `agent prompt` (agent not detected). */
async function fakeHerdrBinary() {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-herdr-"));
  const log = join(dir, "calls.log");
  await writeFile(
    join(dir, "herdr"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t2"},"pane":{"pane_id":"w1:p3"}}}' ;;
  "agent prompt") echo 'agent_not_found' >&2; exit 1 ;;
esac
`,
  );
  await chmod(join(dir, "herdr"), 0o755);
  return { dir, calls: async () => (await readFile(log, "utf8")).trim().split("\n") };
}

test("the Lead's workspace comes from its own pane id", () => {
  assert.equal(workspaceFromPaneId("w1:p1"), "w1");
  assert.equal(workspaceFromPaneId(undefined), undefined);
  assert.equal(createHerdrCli({}), undefined, "outside Herdr there is no client");
});

test("tabs open without focus, and messages fall back to typing when no agent is detected", async () => {
  const { dir, calls } = await fakeHerdrBinary();
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    assert.deepEqual(await herdr.openWorkerTab({ label: "lead: x", cwd: "/tmp", command: "/bin/sh '/tmp/run.sh'" }), {
      tabId: "w1:t2",
      paneId: "w1:p3",
    });
    await herdr.sendToAgent("w1:p3", "[PI Lead] use ISO 8601\nthanks");
    await herdr.closeTab("w1:t2");
    assert.deepEqual(await calls(), [
      "tab create --workspace w1 --cwd /tmp --label lead: x --no-focus",
      "pane run w1:p3 /bin/sh '/tmp/run.sh'",
      "agent prompt w1:p3 [PI Lead] use ISO 8601\nthanks",
      "pane run w1:p3 [PI Lead] use ISO 8601 thanks",
      "tab close w1:t2",
    ].flatMap((line) => line.split("\n")));
  } finally {
    process.env.PATH = previous;
  }
});
