import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { collectGitProposal, prepareCommittedBase } from "./git-proposal.ts";
import { createProposedChangePolicy } from "./proposed-change-policy.ts";
import {
  ProposedChangeRuntimeFailure,
  runProposedChangeTask,
  type ProposedChangeRuntime,
  type ProposedChangeWorker,
  type ProposedChangeWorkerResult,
} from "./proposed-change-task.ts";
import { runProposedChangeWorkerHost } from "./proposed-change-worker-host.ts";
import { writeJsonAtomically } from "./state-files.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
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

const root = await mkdtemp(join(tmpdir(), "pi-lead-change-fixture-"));
const denyBootstrap = process.argv.includes("--deny-bootstrap");
const mutatingCheck = process.argv.includes("--mutating-check");
const repository = join(root, "consumer");
const stateDirectory = join(root, "state");
await git(root, ["init", "--quiet", "--initial-branch=main", repository]);
await writeFile(join(repository, "value.txt"), "before\n");
await writeFile(
  join(repository, ".mise.toml"),
  mutatingCheck
    ? '[tasks.test]\nrun = "printf mutated > value.txt"\n'
    : '[tasks.test]\nrun = "test \\"$(cat value.txt)\\" = after"\n',
);
await git(repository, ["add", "."]);
await git(repository, [
  "-c",
  "user.name=PI Lead Fixture",
  "-c",
  "user.email=fixture@pi-lead.invalid",
  "commit",
  "--quiet",
  "-m",
  "fixture base",
]);
const prepared = await prepareCommittedBase({
  repositoryPath: repository,
  namedBase: "main",
  outputPath: join(stateDirectory, "base.bundle"),
});
const taskId = randomUUID();
const assignmentId = randomUUID();
const workerId = randomUUID();
const piSessionId = randomUUID();
const dependencyHosts = denyBootstrap ? [] : ["dl-cdn.alpinelinux.org"];
const policy = createProposedChangePolicy({
  workerId,
  dependencyHosts,
  validationTasks: ["test"],
});
await writeFile(join(stateDirectory, "heartbeat"), new Date().toISOString(), "utf8");
await writeJsonAtomically(join(stateDirectory, "launch.json"), {
  schemaVersion: 1,
  taskId,
  assignmentId,
  instruction: "Change value.txt from before to after.",
  namedBase: "main",
  baseCommit: prepared.baseCommit,
  workerId,
  piSessionId,
  tabId: "fixture-tab",
  paneId: "fixture-pane",
  modelId: "gpt-5.6-luna",
  policy,
  controllerHeartbeatTimeoutMs: 60_000,
});
const heartbeat = setInterval(() => {
  void writeFile(join(stateDirectory, "heartbeat"), new Date().toISOString(), "utf8");
}, 1_000);
try {
  await runProposedChangeWorkerHost({
    stateDirectory,
    fixtureEdit: { path: "value.txt", contents: "after\n" },
    debugLog(message) {
      process.stderr.write(`[gondolin] ${message}\n`);
    },
  });
} finally {
  clearInterval(heartbeat);
}

const resources = JSON.parse(await readFile(join(stateDirectory, "resources.json"), "utf8")) as {
  vmId: string;
};
const ownedWorker: ProposedChangeWorker = {
  taskId,
  assignmentId,
  workerId,
  vmId: resources.vmId,
  tabId: "fixture-tab",
  paneId: "fixture-pane",
  piSessionId,
  baseCommit: prepared.baseCommit,
};
const termination = JSON.parse(
  await readFile(join(stateDirectory, "termination.json"), "utf8"),
) as { terminated: boolean };
const runtime: ProposedChangeRuntime = {
  async launch() {
    return ownedWorker;
  },
  async waitForResult() {
    const errorText = await readFile(join(stateDirectory, "error.json"), "utf8").catch(
      () => undefined,
    );
    if (errorText) {
      const error = JSON.parse(errorText) as { reason?: string; detail: string };
      throw new ProposedChangeRuntimeFailure(
        error.reason === "DEPENDENCY_DESTINATION_DENIED"
          ? "DEPENDENCY_DESTINATION_DENIED"
          : "RUNTIME_FAILURE",
        error.detail,
      );
    }
    return JSON.parse(
      await readFile(join(stateDirectory, "result.json"), "utf8"),
    ) as ProposedChangeWorkerResult;
  },
  async collectResult(result) {
    const collected = await collectGitProposal({
      baseCommit: prepared.baseCommit,
      bundlePath: join(stateDirectory, "proposal.bundle"),
      collectionDirectory: join(stateDirectory, "collection"),
    });
    assert.equal(result.proposedCommit, collected.proposedCommit);
    return { artifactId: collected.artifactId, files: collected.files };
  },
  async terminate() {
    return { vmId: resources.vmId, terminated: termination.terminated };
  },
  async closeSuccessfulTab() {},
};
const summary = await runProposedChangeTask(
  {
    taskId,
    assignmentId,
    instruction: "Change value.txt from before to after.",
    repositoryPath: repository,
    namedBase: "main",
    validationTasks: ["test"],
    dependencyHosts,
  },
  runtime,
);

assert.equal(termination.terminated, true);
assert.equal(await readFile(join(repository, "value.txt"), "utf8"), "before\n");
if (denyBootstrap) {
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "DEPENDENCY_DESTINATION_DENIED");
    assert.match(summary.detail ?? "", /dl-cdn\.alpinelinux\.org/);
  }
} else if (mutatingCheck) {
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") assert.equal(summary.reason, "VALIDATION_FAILED");
} else {
  assert.equal(summary.status, "REVIEW_REQUIRED");
  if (summary.status === "REVIEW_REQUIRED") {
    assert.equal(summary.files.some((file) => file.path === "value.txt"), true);
  }
}
process.stdout.write(
  `${JSON.stringify(
    {
      ...summary,
      stateDirectory,
      hostCheckoutPreserved: true,
      ...(denyBootstrap ? { allowedDependencyHosts: [], policyExpanded: false } : {}),
    },
    null,
    2,
  )}\n`,
);
