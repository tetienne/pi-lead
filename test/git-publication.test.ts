import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { publishTaskBranch, type PublicationEvent } from "../src/git-publication.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", args, {
    cwd, encoding: "utf8", env: { HOME: cwd, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout.trim();
}

async function taskBranchFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-publish-"));
  const repository = join(root, "consumer");
  const remote = join(root, "remote.git");
  await git(root, "init", "--quiet", "--initial-branch=main", repository);
  await writeFile(join(repository, "value.txt"), "base\n");
  await git(repository, "add", "value.txt");
  await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await git(repository, "switch", "--quiet", "-c", "pi-lead/task-5");
  await writeFile(join(repository, "value.txt"), "reviewed\n");
  await git(repository, "add", "value.txt");
  await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "reviewed");
  const commit = await git(repository, "rev-parse", "HEAD");
  await git(root, "init", "--bare", "--quiet", remote);
  await git(repository, "remote", "add", "publish", remote);
  return { repository, remote, commit };
}

test("publication pushes only the exact reviewed task branch and records intent before its observed outcome", async () => {
  const fixture = await taskBranchFixture();
  const events: PublicationEvent[] = [];
  const result = await publishTaskBranch({
    repositoryPath: fixture.repository, configuredRemoteName: "publish", branchName: "pi-lead/task-5", commit: fixture.commit,
    journal: { async record(event) { events.push(event); } },
  });
  assert.equal(result.status, "PUBLISHED");
  assert.equal(await git(fixture.repository, "ls-remote", "--heads", "publish", "refs/heads/pi-lead/task-5"), `${fixture.commit}\trefs/heads/pi-lead/task-5`);
  assert.deepEqual(events.map((event) => event.phase), ["INTENDED", "OBSERVED"]);
  assert.equal(events[1]?.phase === "OBSERVED" && events[1].outcome, "PUBLISHED");
});

test("publication blocks missing and ambiguous configured remotes without creating one", async () => {
  const fixture = await taskBranchFixture();
  const missing = await publishTaskBranch({ repositoryPath: fixture.repository, branchName: "pi-lead/task-5", commit: fixture.commit });
  assert.equal(missing.status, "BLOCKED");
  assert.match(missing.detail ?? "", /No consuming-project/);
  const absent = await publishTaskBranch({ repositoryPath: fixture.repository, configuredRemoteName: "absent", branchName: "pi-lead/task-5", commit: fixture.commit });
  assert.equal(absent.status, "BLOCKED");
  await git(fixture.repository, "remote", "set-url", "--add", "--push", "publish", "https://example.invalid/one.git");
  await git(fixture.repository, "remote", "set-url", "--add", "--push", "publish", "https://example.invalid/two.git");
  const ambiguous = await publishTaskBranch({ repositoryPath: fixture.repository, configuredRemoteName: "publish", branchName: "pi-lead/task-5", commit: fixture.commit });
  assert.equal(ambiguous.status, "BLOCKED");
  assert.match(ambiguous.detail ?? "", /ambiguous/);
});

test("publication refuses protected, arbitrary, force-like, and existing unrelated destinations", async () => {
  const fixture = await taskBranchFixture();
  await assert.rejects(
    publishTaskBranch({ repositoryPath: fixture.repository, configuredRemoteName: "publish", branchName: "main", commit: fixture.commit }),
    /only PI Lead task branches/,
  );
  await git(fixture.repository, "push", "--quiet", "publish", "HEAD:refs/heads/pi-lead/task-5");
  await git(fixture.repository, "commit", "--allow-empty", "--quiet", "-m", "different local state");
  const different = await git(fixture.repository, "rev-parse", "HEAD");
  const result = await publishTaskBranch({ repositoryPath: fixture.repository, configuredRemoteName: "publish", branchName: "pi-lead/task-5", commit: different });
  assert.equal(result.status, "BLOCKED");
  assert.match(result.detail ?? "", /refusing to overwrite/);
});
