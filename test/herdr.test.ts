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
  const argv = join(dir, "argv.log");
  await writeFile(
    join(dir, "herdr"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
for arg in "$@"; do printf '[%s]' "$arg" >> '${argv}'; done
echo >> '${argv}'
case "$1 $2" in
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t2"},"pane":{"pane_id":"w1:p3"}}}' ;;
  "tab list") echo '{"result":{"tabs":[{"tab_id":"w1:t1","label":"lead"},{"tab_id":"w1:t2","label":"lead: x"}]}}' ;;
  "agent prompt") echo 'agent_not_found' >&2; exit 1 ;;
esac
`,
  );
  await chmod(join(dir, "herdr"), 0o755);
  return {
    dir,
    calls: async () => (await readFile(log, "utf8")).trim().split("\n"),
    /** Exact argv, one bracket per argument. */
    argv: async () => (await readFile(argv, "utf8")).trim().split("\n"),
  };
}

test("tab listing, pane metadata and agent names go through argv, never a shell", async () => {
  const { dir, argv } = await fakeHerdrBinary();
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    assert.equal(herdr.workspace, "w1");
    assert.deepEqual(await herdr.listTabs("w1"), ["w1:t1", "w1:t2"]);
    await herdr.reportMetadata("w1:p3", {
      title: "Fix $(whoami) bug",
      displayAgent: "pi-lead debug",
      tokens: { model: "anthropic/claude-opus-5-5", thinking: "high", branch: "pi-lead/fix-bug-abc123", worker: "abcdef12", state: "running" },
      workingLabel: "debug: Fix $(whoami) bug",
    });
    await herdr.renameAgent("w1:p3", "lead-fix-bug-abcd");
    assert.deepEqual(await argv(), [
      "[tab][list][--workspace][w1]",
      "[pane][report-metadata][w1:p3][--source][custom:pi-lead][--agent][pi][--title][Fix $(whoami) bug]" +
        "[--display-agent][pi-lead debug][--token][model=anthropic/claude-opus-5-5][--token][thinking=high]" +
        "[--token][branch=pi-lead/fix-bug-abc123][--token][worker=abcdef12][--token][state=running]" +
        "[--state-label][working=debug: Fix $(whoami) bug]",
      "[agent][rename][w1:p3][lead-fix-bug-abcd]",
    ]);
  } finally {
    process.env.PATH = previous;
  }
});

test("the Lead's workspace comes from its own pane id", () => {
  assert.equal(workspaceFromPaneId("w1:p1"), "w1");
  assert.equal(workspaceFromPaneId(undefined), undefined);
  assert.equal(createHerdrCli({}), undefined, "outside Herdr there is no client");
});

test("tabs open without focus, and messages never fall back to typing into the pane", async () => {
  const { dir, calls } = await fakeHerdrBinary();
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    assert.deepEqual(await herdr.openWorkerTab({ label: "lead: x", cwd: "/tmp", command: "/bin/sh '/tmp/run.sh'" }), {
      tabId: "w1:t2",
      paneId: "w1:p3",
    });
    // Not detected as an agent (e.g. Pi exited, the pane is a shell): refuse rather than type.
    await assert.rejects(herdr.sendToAgent("w1:p3", "[PI Lead] $(rm -rf ~)"));
    await herdr.closeTab("w1:t2");
    assert.deepEqual(await calls(), [
      "tab create --workspace w1 --cwd /tmp --label lead: x --no-focus",
      "pane run w1:p3 /bin/sh '/tmp/run.sh'",
      "agent prompt w1:p3 [PI Lead] $(rm -rf ~)",
      "tab close w1:t2",
    ]);
  } finally {
    process.env.PATH = previous;
  }
});
