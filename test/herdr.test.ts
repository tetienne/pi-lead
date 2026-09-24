import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHerdrCli, isUsageError, workspaceFromPaneId } from "../src/herdr.ts";

/** A fake `herdr` on PATH that logs its argv and refuses `agent prompt` (agent not detected). */
async function fakeHerdrBinary(options: { rejectSeq?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-lead-herdr-"));
  const log = join(dir, "calls.log");
  const argv = join(dir, "argv.log");
  await writeFile(
    join(dir, "herdr"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
for arg in "$@"; do printf '[%s]' "$arg" >> '${argv}'; done
echo >> '${argv}'
${options.rejectSeq ? `case "$*" in *--seq*) echo "error: unexpected argument '--seq'" >&2; exit 2 ;; esac` : ""}
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
      workingLabel: "debug · claude-opus-5-5 · high",
      idleLabel: "needs your answer",
      blockedLabel: "needs your answer",
      seq: 42,
    });
    await herdr.renameAgent("w1:p3", "lead-fix-bug-abcd");
    await herdr.renameTab("w1:t2", "? Fix $(whoami) bug");
    await herdr.notify("? Fix bug: needs your answer", "request");
    assert.deepEqual(await argv(), [
      "[tab][list][--workspace][w1]",
      "[pane][report-metadata][--source][custom:pi-lead][--agent][pi][--title=Fix $(whoami) bug]" +
        "[--display-agent=pi-lead debug][--token=model=anthropic/claude-opus-5-5][--token=thinking=high]" +
        "[--token=branch=pi-lead/fix-bug-abc123][--token=worker=abcdef12][--token=state=running]" +
        "[--state-label=working=debug · claude-opus-5-5 · high][--state-label=idle=needs your answer]" +
        "[--state-label=done=needs your answer][--state-label=blocked=needs your answer][--seq=42][--][w1:p3]",
      "[agent][rename][w1:p3][lead-fix-bug-abcd]",
      // `--` first: a label or title starting with `-` stays a positional argument.
      "[tab][rename][--][w1:t2][? Fix $(whoami) bug]",
      "[notification][show][--sound=request][--][? Fix bug: needs your answer]",
    ]);
  } finally {
    process.env.PATH = previous;
  }
});

test("an older Herdr that rejects --seq or the new state labels still gets title, tokens and the working label", async () => {
  const { dir, argv } = await fakeHerdrBinary({ rejectSeq: true });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    const metadata = { title: "T", displayAgent: "pi-lead debug", tokens: {}, workingLabel: "w", idleLabel: "i", blockedLabel: "b", seq: 1 };
    await herdr.reportMetadata("w1:p3", metadata);
    await herdr.reportMetadata("w1:p3", { ...metadata, seq: 2 });
    const legacy = "[pane][report-metadata][--source][custom:pi-lead][--agent][pi][--title=T][--display-agent=pi-lead debug][--state-label=working=w][--][w1:p3]";
    const calls = await argv();
    assert.equal(calls.length, 3, "one failed full report, then the older form only");
    assert.match(calls[0]!, /\[--seq=1\]/);
    assert.deepEqual(calls.slice(1), [legacy, legacy]);
  } finally {
    process.env.PATH = previous;
  }
});

test("only a rejected command line counts as an older Herdr, never a timeout or a missing tab", () => {
  assert.ok(isUsageError({ code: 2, stderr: "" }));
  assert.ok(isUsageError(new Error("Command failed: herdr tab rename\nerror: unrecognized subcommand 'rename'")));
  assert.ok(isUsageError({ code: 1, stderr: "error: unexpected argument '--seq' found" }));
  assert.ok(!isUsageError({ code: 1, stderr: "tab_not_found" }));
  assert.ok(!isUsageError(Object.assign(new Error("Command failed: herdr"), { killed: true, signal: "SIGTERM" })));
  assert.ok(!isUsageError(undefined));
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
      "tab create --workspace w1 --cwd /tmp --label=lead: x --no-focus",
      "pane run w1:p3 /bin/sh '/tmp/run.sh'",
      "agent prompt w1:p3 [PI Lead] $(rm -rf ~)",
      "tab close w1:t2",
    ]);
  } finally {
    process.env.PATH = previous;
  }
});
