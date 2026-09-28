import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHerdrCli, workspaceFromPaneId } from "../src/herdr.ts";

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
  "workspace list")
    for arg in "$@"; do
      case "$arg" in --label=*) echo "unknown option: $arg" >&2; exit 2 ;; esac
    done
    ;;
  "pane report-metadata")
    case "$3" in w1:p3) ;; *) echo "unknown option: $3" >&2; exit 2 ;; esac
    for arg in "$@"; do
      case "$arg" in --*=*) echo "unknown option: $arg" >&2; exit 2 ;; esac
    done
    ;;
  "notification show")
    case "$3" in --*) echo "unknown option: $3" >&2; exit 2 ;; esac
    for arg in "$@"; do
      case "$arg" in --sound=*) echo "unknown option: $arg" >&2; exit 2 ;; esac
    done
    ;;
esac
case "$1 $2" in
  "worktree create") echo '{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w1"},"root_pane":{"pane_id":"w1:p3"}}}' ;;
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1"},{"workspace_id":"w2"}]}}' ;;
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

test("workspace listing, pane metadata and agent names go through argv, never a shell", async () => {
  const { dir, argv } = await fakeHerdrBinary();
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    assert.equal(herdr.workspace, "w1");
    assert.deepEqual(await herdr.listWorkspaces(), ["w1", "w2"]);
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
    await herdr.renameWorktree("w1", "? Fix $(whoami) bug");
    await herdr.notify("? Fix bug: needs your answer", "request");
    assert.deepEqual(await argv(), [
      "[workspace][list]",
      "[pane][report-metadata][w1:p3][--source][custom:pi-lead][--agent][pi][--title][Fix $(whoami) bug]" +
        "[--display-agent][pi-lead debug][--token][model=anthropic/claude-opus-5-5][--token][thinking=high]" +
        "[--token][branch=pi-lead/fix-bug-abc123][--token][worker=abcdef12][--token][state=running]" +
        "[--state-label][working=debug · claude-opus-5-5 · high][--state-label][idle=needs your answer]" +
        "[--state-label][done=needs your answer][--state-label][blocked=needs your answer][--seq][42]",
      "[agent][rename][w1:p3][lead-fix-bug-abcd]",
      // `--` first: a label starting with `-` stays a positional argument.
      "[workspace][rename][--][w1][? Fix $(whoami) bug]",
      "[notification][show][? Fix bug: needs your answer][--sound][request]",
    ]);
  } finally {
    process.env.PATH = previous;
  }
});

test("a Herdr that rejects --seq gets no older form of the report: 0.9.1 is required", async () => {
  const { dir, argv } = await fakeHerdrBinary({ rejectSeq: true });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    const metadata = { title: "T", displayAgent: "pi-lead debug", tokens: {}, workingLabel: "w", idleLabel: "i", blockedLabel: "b", seq: 1 };
    await assert.rejects(herdr.reportMetadata("w1:p3", metadata));
    await assert.rejects(herdr.reportMetadata("w1:p3", { ...metadata, seq: 2 }));
    const calls = await argv();
    assert.equal(calls.length, 2, "one full report per call, no retry without --seq");
    assert.ok(calls.every((call) => call.includes("[--seq]")));
  } finally {
    process.env.PATH = previous;
  }
});

test("the Lead's workspace comes from its own pane id", () => {
  assert.equal(workspaceFromPaneId("w1:p1"), "w1");
  assert.equal(workspaceFromPaneId(undefined), undefined);
  assert.equal(createHerdrCli({}), undefined, "outside Herdr there is no client");
});

test("worktrees open without focus, and messages never fall back to typing into the pane", async () => {
  const { dir, calls, argv } = await fakeHerdrBinary();
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    const herdr = createHerdrCli({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })!;
    assert.deepEqual(
      await herdr.createWorktree({ cwd: "/tmp/repo", branch: "pi-lead/x-1", base: "abc123", path: "/tmp/repo-x-1", label: "○ Retry issue 316 Planning Cours…" }),
      { workspaceId: "w1", paneId: "w1:p3" },
    );
    await herdr.runCommand("w1:p3", "/bin/sh '/tmp/run.sh'");
    // Not detected as an agent (e.g. Pi exited, the pane is a shell): refuse rather than type.
    await assert.rejects(herdr.sendToAgent("w1:p3", "[PI Lead] $(rm -rf ~)"));
    await herdr.removeWorktree("w1");
    assert.deepEqual(await calls(), [
      "worktree create --cwd /tmp/repo --branch pi-lead/x-1 --base abc123 --path /tmp/repo-x-1 --label ○ Retry issue 316 Planning Cours… --no-focus",
      "pane run w1:p3 /bin/sh '/tmp/run.sh'",
      "agent prompt w1:p3 [PI Lead] $(rm -rf ~)",
      "worktree remove --workspace w1 --force",
    ]);
    assert.equal(
      (await argv())[0],
      "[worktree][create][--cwd][/tmp/repo][--branch][pi-lead/x-1][--base][abc123][--path][/tmp/repo-x-1][--label][○ Retry issue 316 Planning Cours…][--no-focus]",
    );
  } finally {
    process.env.PATH = previous;
  }
});
