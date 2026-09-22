import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createNativeOpenCodeGoRuntime } from "../src/native-opencode-go-runtime.ts";
import { runReadOnlyOpenCodeGoTask, type OpenCodeGoTaskRuntime } from "../src/opencode-go-task.ts";

test("an allowed OpenCode Go worker keeps its native provider and stops immediately on exhaustion", async () => {
  const worker = { taskId: "task-go", assignmentId: "assignment-go", workerId: "worker-go", vmId: "vm-go", tabId: "tab-go", paneId: "pane-go", piSessionId: "session-go" };
  let terminated = false;
  const runtime: OpenCodeGoTaskRuntime = {
    async launch(request) {
      assert.equal(request.provider, "opencode-go");
      assert.deepEqual(request.allowedHosts, ["opencode.ai"]);
      assert.equal(request.tabLabel, "PI Lead · OpenCode Go read-only worker");
      return worker;
    },
    async waitForResult() { return { ...worker, status: "failed" as const, failure: "QUOTA_EXHAUSTED" as const, detail: "included allowance exhausted", nativeEvents: [] }; },
    async collectResult() { throw new Error("an exhausted provider has no result"); },
    async terminate() { terminated = true; return { vmId: worker.vmId, terminated: true }; },
    async closeSuccessfulTab() { throw new Error("an exhausted provider cannot close as success"); },
  };
  const summary = await runReadOnlyOpenCodeGoTask({ taskId: worker.taskId, assignmentId: worker.assignmentId, question: "Question" }, runtime);
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") assert.equal(summary.reason, "QUOTA_EXHAUSTED");
  assert.equal(terminated, true);
});

test("the native Go runtime persists Pi's provider and selected model before starting its launcher", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-opencode-runtime-"));
  let directory = "";
  const runtime = await createNativeOpenCodeGoRuntime({
    cwd: "/consumer", workspaceId: "workspace", stateRoot, pollIntervalMs: 1,
    herdr: {
      async createBackgroundTab() { return { tabId: "tab-go", paneId: "pane-go" }; },
      async tabExists() { return true; }, async closeTab() {},
    },
    processHost: {
      async start(request) {
        directory = request.stateDirectory;
        const launch = JSON.parse(await readFile(join(directory, "launch.json"), "utf8")) as { modelId: string; policy: unknown; workerId: string };
        assert.equal(launch.modelId, "gpt-5.6-luna");
        assert.deepEqual(launch.policy, { provider: "opencode-go", allowedHosts: ["opencode.ai"], allowWebSockets: false, hostMounts: [], inheritHostEnvironment: false });
        await writeFile(join(directory, "resources.json"), JSON.stringify({
          workerId: launch.workerId,
          vmId: "vm-go",
          effectiveRoute: { provider: "opencode-go", modelId: launch.modelId, reasoning: "off" },
        }));
      },
    },
  });
  const worker = await runtime.launch({ taskId: "task-go", assignmentId: "assignment-go", question: "Question", provider: "opencode-go", allowedHosts: ["opencode.ai"], allowWebSockets: false, focus: false, hostMounts: [], inheritHostEnvironment: false, tabLabel: "PI Lead · OpenCode Go read-only worker" });
  await writeFile(join(directory, "termination.json"), JSON.stringify({ vmId: worker.vmId, terminated: true }));
  assert.deepEqual(await runtime.terminate(worker), { vmId: "vm-go", terminated: true });
});
