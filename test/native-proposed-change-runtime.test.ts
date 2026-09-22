import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { PROPOSAL_REF } from "../src/git-proposal.ts";
import {
  assertResearchNote,
  createNativeProposedChangeRuntime,
  type ProposedChangeProcessHost,
} from "../src/native-proposed-change-runtime.ts";
import type { HerdrClient } from "../src/native-runtime.ts";

const execFileAsync = promisify(execFile);

test("research collection accepts one cited Markdown note and rejects unreviewable output", () => {
  const note = {
    path: "docs/research/result.md", status: "added" as const,
    oldMode: "000000", newMode: "100644",
    contentBase64: Buffer.from("Finding. [Primary source](https://example.com/spec)").toString("base64"),
    binary: false,
  };
  assert.doesNotThrow(() => assertResearchNote([note]));
  assert.throws(() => assertResearchNote([{ ...note, path: "src/result.ts" }]), /exactly one Markdown note/);
  assert.throws(() => assertResearchNote([{ ...note, contentBase64: Buffer.from("No citation").toString("base64") }]), /primary-source citations/);
  assert.throws(() => assertResearchNote([note, { ...note, path: "docs/research/extra.md" }]), /exactly one Markdown note/);
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    env: { HOME: cwd, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout.trim();
}

test("native change runtime transfers the named base and collects only its correlated proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-native-change-"));
  const consumer = join(root, "consumer");
  const stateRoot = join(root, "state");
  await git(root, "init", "--quiet", "--initial-branch=main", consumer);
  await writeFile(join(consumer, "value.txt"), "before\n");
  await git(consumer, "add", "value.txt");
  await git(
    consumer,
    "-c",
    "user.name=PI Lead Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  await writeFile(join(consumer, "local.txt"), "must remain local\n");
  const statusBefore = await git(consumer, "status", "--porcelain=v1", "--untracked-files=all");
  let stateDirectory = "";
  let routeVerified = false;
  const herdr: HerdrClient = {
    async createBackgroundTab(request) {
      assert.deepEqual(request, {
        workspaceId: "workspace-1",
        cwd: consumer,
        label: "PI Lead · proposed change",
        focus: false,
      });
      return { tabId: "tab-change", paneId: "pane-change" };
    },
    async tabExists() {
      return true;
    },
    async closeTab() {},
  };
  const processHost: ProposedChangeProcessHost = {
    async start(request) {
      stateDirectory = request.stateDirectory;
      const launch = JSON.parse(await readFile(join(stateDirectory, "launch.json"), "utf8")) as {
        workerId: string;
        baseCommit: string;
        taskId: string;
        assignmentId: string;
        tabId: string;
        paneId: string;
        piSessionId: string;
        toolchainCache: {
          state: string;
          seedId: string;
          host: { seedDirectory: string };
          guest: { platform: string; seedDirectory: string };
          environment: { MISE_DATA_DIR: string };
        };
      };
      assert.deepEqual(launch.toolchainCache.guest, {
        platform: "linux-x64-musl",
        seedDirectory: "/opt/pi-lead/mise-seed",
      });
      assert.equal(launch.toolchainCache.state, "COLD");
      assert.equal(launch.toolchainCache.host.seedDirectory.startsWith(join(root, "cache")), true);
      assert.match(launch.toolchainCache.environment.MISE_DATA_DIR, /pi-lead-.+\/mise\/data$/);
      const guest = join(root, "guest");
      await git(root, "clone", "--quiet", "--branch", "main", join(stateDirectory, "base.bundle"), guest);
      await git(guest, "switch", "--quiet", "-c", "pi-lead-proposal", "HEAD");
      await writeFile(join(guest, "value.txt"), "after\n");
      await git(guest, "add", "value.txt");
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
      const proposedCommit = await git(guest, "rev-parse", "HEAD");
      await git(guest, "bundle", "create", join(stateDirectory, "proposal.bundle"), PROPOSAL_REF);
      await writeFile(
        join(stateDirectory, "resources.json"),
        JSON.stringify({
          workerId: launch.workerId,
          vmId: "vm-change",
          effectiveRoute: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "medium" },
        }),
      );
      await writeFile(
        join(stateDirectory, "result.json"),
        JSON.stringify({
          ...launch,
          vmId: "vm-change",
          status: "proposed",
          proposedCommit,
          validations: [
            { task: "test", command: "mise run test", passed: true, exitCode: 0 },
          ],
          toolchainCache: {
            seedId: launch.toolchainCache.seedId,
            state: launch.toolchainCache.state,
            seedCopyMs: 3,
            guestToolchainPreparationMs: 11,
            miseReadinessMs: 7,
            validationExecutionMs: 5,
          },
        }),
      );
    },
  };
  const runtime = await createNativeProposedChangeRuntime({
    cwd: consumer,
    workspaceId: "workspace-1",
    stateRoot,
    toolchainCacheRoot: join(root, "cache"),
    guestArchitecture: "x64",
    herdr,
    processHost,
    pollIntervalMs: 1,
    modelId: "gpt-5.6-luna",
    reasoning: "high",
    onWorkerSpawn(effective) {
      assert.deepEqual(effective, {
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        reasoning: "medium",
      });
      routeVerified = true;
    },
  });

  const worker = await runtime.launch({
    taskId: "task-change",
    assignmentId: "assignment-change",
    instruction: "Update value.txt.",
    repositoryPath: consumer,
    namedBase: "main",
    validationTasks: ["test"],
    dependencyHosts: ["registry.npmjs.org"],
    privateWorkspace: true,
    focus: false,
    hostMounts: [],
    allowedDependencyHosts: ["registry.npmjs.org"],
  });
  const result = await runtime.waitForResult(worker);
  assert.equal(routeVerified, true);
  assert.deepEqual(result.toolchainCache, {
    seedId: (JSON.parse(await readFile(join(stateDirectory, "launch.json"), "utf8")) as { toolchainCache: { seedId: string } }).toolchainCache.seedId,
    state: "COLD",
    seedCopyMs: 3,
    guestToolchainPreparationMs: 11,
    miseReadinessMs: 7,
    validationExecutionMs: 5,
  });
  const collected = await runtime.collectResult(result);

  assert.equal(collected.files.length, 1);
  assert.equal(collected.files[0]?.path, "value.txt");
  assert.equal(await git(consumer, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
  await writeFile(
    join(stateDirectory, "termination.json"),
    JSON.stringify({ vmId: worker.vmId, terminated: true }),
  );
  assert.deepEqual(await runtime.terminate(worker), { vmId: "vm-change", terminated: true });
});
