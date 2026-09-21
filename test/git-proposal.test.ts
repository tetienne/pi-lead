import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  deliverGitProposal,
  PROPOSAL_REF,
  collectGitProposal,
  prepareCommittedBase,
} from "../src/git-proposal.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: cwd,
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return stdout.trim();
}

async function createBaseRepository(root: string): Promise<string> {
  const repository = join(root, "consumer");
  await git(root, "init", "--quiet", "--initial-branch=main", repository);
  await writeFile(join(repository, "modified.txt"), "before\n");
  await writeFile(join(repository, "rename-me.txt"), "rename contents\n");
  await writeFile(join(repository, "delete-me.txt"), "delete contents\n");
  await writeFile(join(repository, "script.sh"), "#!/bin/sh\necho before\n");
  await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(repository, ".gitattributes"), "*.danger filter=hostile\n");
  await git(repository, "add", ".");
  await git(
    repository,
    "-c",
    "user.name=PI Lead Test",
    "-c",
    "user.email=pi-lead@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return repository;
}

test("a named committed base is bundled without changing the active checkout or local edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-base-"));
  const repository = await createBaseRepository(root);
  await writeFile(join(repository, "modified.txt"), "local uncommitted edit\n");
  const statusBefore = await git(repository, "status", "--porcelain=v1", "--untracked-files=all");
  const branchBefore = await git(repository, "branch", "--show-current");

  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });

  assert.match(prepared.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(prepared.namedBase, "main");
  assert.equal(await git(repository, "branch", "--show-current"), branchBefore);
  assert.equal(
    await git(repository, "status", "--porcelain=v1", "--untracked-files=all"),
    statusBefore,
  );
  assert.equal(await readFile(join(repository, "modified.txt"), "utf8"), "local uncommitted edit\n");
});

test("a reviewed proposal is delivered to a new local task branch without touching the active checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-deliver-"));
  const repository = await createBaseRepository(root);
  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });
  const guest = join(root, "guest");
  await git(root, "clone", "--quiet", "--branch", "main", prepared.bundlePath, guest);
  await writeFile(join(guest, "modified.txt"), "reviewed change\n");
  await git(guest, "add", "modified.txt");
  await git(
    guest,
    "-c",
    "user.name=Isolated Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "reviewed proposal",
  );
  await git(guest, "branch", "-M", PROPOSAL_REF.replace("refs/heads/", ""));
  const bundle = join(root, "proposal.bundle");
  await git(guest, "bundle", "create", bundle, PROPOSAL_REF);
  const collected = await collectGitProposal({
    baseCommit: prepared.baseCommit,
    bundlePath: bundle,
    collectionDirectory: join(root, "collection"),
  });
  await writeFile(join(repository, "local.txt"), "must remain local\n");
  const statusBefore = await git(repository, "status", "--porcelain=v1", "--untracked-files=all");
  const branchBefore = await git(repository, "branch", "--show-current");

  const delivery = await deliverGitProposal({
    repositoryPath: repository,
    baseCommit: prepared.baseCommit,
    proposedCommit: collected.proposedCommit,
    artifactId: collected.artifactId,
    bundlePath: bundle,
    collectionDirectory: join(root, "delivery-collection"),
    branchName: "pi-lead/task-task-4",
  });

  assert.deepEqual(delivery, {
    branchName: "pi-lead/task-task-4",
    commit: collected.proposedCommit,
    committed: true,
    activeCheckoutPreserved: true,
  });
  assert.equal(await git(repository, "branch", "--show-current"), branchBefore);
  assert.equal(await git(repository, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  assert.equal(await git(repository, "rev-parse", "pi-lead/task-task-4"), collected.proposedCommit);
  await assert.rejects(
    deliverGitProposal({
      repositoryPath: repository,
      baseCommit: prepared.baseCommit,
      proposedCommit: collected.proposedCommit,
      artifactId: collected.artifactId,
      bundlePath: bundle,
      collectionDirectory: join(root, "delivery-collection"),
      branchName: "pi-lead/task-task-4",
    }),
    /already exists/,
  );
});

test("the committed base must be a short branch or tag name, not an object expression", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-base-name-"));
  const repository = await createBaseRepository(root);
  await assert.rejects(
    prepareCommittedBase({
      repositoryPath: repository,
      namedBase: "HEAD",
      outputPath: join(root, "base.bundle"),
    }),
    /Invalid named Git base/,
  );
});

test("collection preserves file bytes, modes, renames, deletions, and confined symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-proposal-"));
  const repository = await createBaseRepository(root);
  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });
  const guest = join(root, "guest");
  await git(root, "clone", "--quiet", "--branch", "main", prepared.bundlePath, guest);
  await git(guest, "switch", "--quiet", "-c", "pi-lead-proposal", "HEAD");
  await writeFile(join(guest, "modified.txt"), "after\n");
  await git(guest, "mv", "rename-me.txt", "renamed.txt");
  await git(guest, "rm", "--quiet", "delete-me.txt");
  await writeFile(join(guest, "new.txt"), "new file\n");
  await writeFile(join(guest, "binary.dat"), Buffer.from([0, 255, 10, 13, 128]));
  await chmod(join(guest, "script.sh"), 0o755);
  await symlink("modified.txt", join(guest, "link-to-modified"));
  await git(guest, "add", "-A");
  await git(
    guest,
    "-c",
    "user.name=Isolated Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "proposed tree",
  );
  await git(guest, "branch", "-M", PROPOSAL_REF.replace("refs/heads/", ""));
  const resultBundle = join(root, "result.bundle");
  await git(guest, "bundle", "create", resultBundle, PROPOSAL_REF);

  const proposal = await collectGitProposal({
    baseCommit: prepared.baseCommit,
    bundlePath: resultBundle,
    collectionDirectory: join(root, "collection"),
  });

  assert.match(proposal.artifactId, /^[0-9a-f]{64}$/);
  assert.match(proposal.proposedCommit, /^[0-9a-f]{40}$/);
  const byPath = new Map(proposal.files.map((file) => [file.path, file]));
  assert.deepEqual([...byPath.keys()].sort(), [
    "binary.dat",
    "delete-me.txt",
    "link-to-modified",
    "modified.txt",
    "new.txt",
    "renamed.txt",
    "script.sh",
  ]);
  assert.equal(byPath.get("renamed.txt")?.status, "renamed");
  assert.equal(byPath.get("renamed.txt")?.previousPath, "rename-me.txt");
  assert.equal(byPath.get("delete-me.txt")?.status, "deleted");
  assert.equal(
    Buffer.from(byPath.get("delete-me.txt")?.previousContentBase64 ?? "", "base64").toString("utf8"),
    "delete contents\n",
  );
  assert.equal(byPath.get("script.sh")?.oldMode, "100644");
  assert.equal(byPath.get("script.sh")?.newMode, "100755");
  assert.equal(byPath.get("binary.dat")?.binary, true);
  assert.deepEqual(
    Buffer.from(byPath.get("binary.dat")?.contentBase64 ?? "", "base64"),
    Buffer.from([0, 255, 10, 13, 128]),
  );
  assert.equal(byPath.get("link-to-modified")?.newMode, "120000");
  assert.equal(byPath.get("link-to-modified")?.symlinkTarget, "modified.txt");
});

test("collection rejects a symlink whose target escapes the proposed workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-symlink-"));
  const repository = await createBaseRepository(root);
  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });
  const guest = join(root, "guest");
  await git(root, "clone", "--quiet", "--branch", "main", prepared.bundlePath, guest);
  await git(guest, "switch", "--quiet", "-c", "pi-lead-proposal", "HEAD");
  await symlink("../../outside", join(guest, "escape"));
  await git(guest, "add", "escape");
  await git(
    guest,
    "-c",
    "user.name=Isolated Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "escaping link",
  );
  await git(guest, "branch", "-M", PROPOSAL_REF.replace("refs/heads/", ""));
  const resultBundle = join(root, "result.bundle");
  await git(guest, "bundle", "create", resultBundle, PROPOSAL_REF);

  await assert.rejects(
    collectGitProposal({
      baseCommit: prepared.baseCommit,
      bundlePath: resultBundle,
      collectionDirectory: join(root, "collection"),
    }),
    /Symlink target escapes the workspace/,
  );
});

test("host collection ignores external Git hooks and filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-hostile-git-"));
  const repository = await createBaseRepository(root);
  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });
  const guest = join(root, "guest");
  await git(root, "clone", "--quiet", "--branch", "main", prepared.bundlePath, guest);
  await writeFile(join(guest, "modified.txt"), "proposal\n");
  await git(guest, "add", "-A");
  await git(
    guest,
    "-c",
    "user.name=Isolated Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "proposal",
  );
  await git(guest, "branch", "-M", PROPOSAL_REF.replace("refs/heads/", ""));
  const resultBundle = join(root, "result.bundle");
  await git(guest, "bundle", "create", resultBundle, PROPOSAL_REF);

  const hooks = join(root, "hostile-hooks");
  const marker = join(root, "host-command-executed");
  await mkdir(hooks);
  await writeFile(join(hooks, "reference-transaction"), `#!/bin/sh\n: > '${marker}'\n`);
  await chmod(join(hooks, "reference-transaction"), 0o755);
  const hostileConfig = join(root, "hostile.gitconfig");
  await writeFile(
    hostileConfig,
    `[core]\n\thooksPath = ${hooks}\n[filter "hostile"]\n\tclean = ${join(hooks, "reference-transaction")}\n`,
  );
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostileConfig;
  try {
    const proposal = await collectGitProposal({
      baseCommit: prepared.baseCommit,
      bundlePath: resultBundle,
      collectionDirectory: join(root, "collection"),
    });
    assert.equal(proposal.files.some((file) => file.path === "modified.txt"), true);
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("collection rejects a changed symlink that escapes through a base symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-symlink-chain-"));
  const repository = await createBaseRepository(root);
  await symlink("../../outside", join(repository, "base-escape"));
  await git(repository, "add", "base-escape");
  await git(
    repository,
    "-c",
    "user.name=PI Lead Test",
    "-c",
    "user.email=pi-lead@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base symlink",
  );
  const prepared = await prepareCommittedBase({
    repositoryPath: repository,
    namedBase: "main",
    outputPath: join(root, "base.bundle"),
  });
  const guest = join(root, "guest");
  await git(root, "clone", "--quiet", "--branch", "main", prepared.bundlePath, guest);
  await symlink("base-escape/file", join(guest, "changed-link"));
  await git(guest, "add", "changed-link");
  await git(
    guest,
    "-c",
    "user.name=Isolated Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "symlink chain",
  );
  await git(guest, "branch", "-M", PROPOSAL_REF.replace("refs/heads/", ""));
  const resultBundle = join(root, "result.bundle");
  await git(guest, "bundle", "create", resultBundle, PROPOSAL_REF);

  await assert.rejects(
    collectGitProposal({
      baseCommit: prepared.baseCommit,
      bundlePath: resultBundle,
      collectionDirectory: join(root, "collection"),
    }),
    /Symlink target escapes the workspace/,
  );
});
