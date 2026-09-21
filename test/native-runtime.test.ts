import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createNativeFixtureRuntime,
  parseHerdrOutput,
  type FixtureProcessHost,
  type HerdrClient,
} from "../src/native-runtime.ts";

test("accepts a successful Herdr command with no JSON response body", () => {
  assert.equal(parseHerdrOutput("  \n"), undefined);
  assert.deepEqual(parseHerdrOutput('{"result":{"type":"ok"}}\n'), {
    result: { type: "ok" },
  });
});

test("native runtime owns a no-focus Herdr tab and accepts only its launcher's resource identity", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-native-test-"));
  const calls: string[] = [];
  let stateDirectory = "";

  const herdr: HerdrClient = {
    async createBackgroundTab(request) {
      calls.push("create-tab");
      assert.deepEqual(request, {
        workspaceId: "workspace-1",
        cwd: "/consumer",
        label: "PI Lead · isolated fixture",
        focus: false,
      });
      return { tabId: "tab-native", paneId: "pane-native" };
    },
    async tabExists(tabId) {
      assert.equal(tabId, "tab-native");
      return true;
    },
    async closeTab(tabId) {
      assert.equal(tabId, "tab-native");
      calls.push("close-tab");
    },
  };
  const processHost: FixtureProcessHost = {
    async start(request) {
      calls.push("start-launcher");
      assert.equal(request.paneId, "pane-native");
      stateDirectory = request.stateDirectory;
      const launch = JSON.parse(await readFile(join(stateDirectory, "launch.json"), "utf8")) as {
        workerId: string;
      };
      await writeFile(
        join(stateDirectory, "resources.json"),
        JSON.stringify({ vmId: "vm-native", workerId: launch.workerId }),
      );
    },
  };
  const runtime = await createNativeFixtureRuntime({
    cwd: "/consumer",
    workspaceId: "workspace-1",
    stateRoot,
    herdr,
    processHost,
    pollIntervalMs: 1,
  });

  const worker = await runtime.launch({
    taskId: "task-native",
    assignmentId: "assignment-native",
    allowedHosts: [],
    allowWebSockets: false,
    focus: false,
    guestWorkspace: "/workspace",
    hostMounts: [],
    inheritHostEnvironment: false,
    tabLabel: "PI Lead · isolated fixture",
  });
  assert.equal(worker.vmId, "vm-native");
  assert.equal(worker.tabId, "tab-native");
  assert.equal(worker.paneId, "pane-native");

  await writeFile(
    join(stateDirectory, "result.json"),
    JSON.stringify({ ...worker, output: "fixture complete" }),
  );
  const result = await runtime.waitForResult(worker);
  const collected = await runtime.collectResult(result);
  assert.equal(collected.output, "fixture complete");
  assert.ok(collected.artifactId);

  await writeFile(
    join(stateDirectory, "termination.json"),
    JSON.stringify({ vmId: worker.vmId, terminated: true }),
  );
  assert.deepEqual(await runtime.terminate(worker), {
    vmId: "vm-native",
    terminated: true,
  });
  await runtime.closeSuccessfulTab(worker.tabId);

  assert.deepEqual(calls, ["create-tab", "start-launcher", "close-tab"]);
});
