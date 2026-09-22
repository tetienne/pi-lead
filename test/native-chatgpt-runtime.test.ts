import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createNativeChatGptRuntime,
  type ChatGptProcessHost,
} from "../src/native-chatgpt-runtime.ts";
import type { HerdrClient } from "../src/native-runtime.ts";

test("native ChatGPT runtime persists no credential and binds native Pi evidence to its owned session", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-chatgpt-native-test-"));
  let stateDirectory = "";
  const calls: string[] = [];
  const herdr: HerdrClient = {
    async createBackgroundTab(request) {
      assert.deepEqual(request, {
        workspaceId: "workspace-1",
        cwd: "/consumer",
        label: "PI Lead · ChatGPT read-only worker",
        focus: false,
      });
      calls.push("create-tab");
      return { tabId: "tab-chatgpt", paneId: "pane-chatgpt" };
    },
    async tabExists() {
      return true;
    },
    async closeTab(tabId) {
      assert.equal(tabId, "tab-chatgpt");
      calls.push("close-tab");
    },
  };
  const processHost: ChatGptProcessHost = {
    async start(request) {
      stateDirectory = request.stateDirectory;
      calls.push("start-launcher");
      const launchText = await readFile(join(stateDirectory, "launch.json"), "utf8");
      assert.equal(/access.?token|refresh.?token|bearer/i.test(launchText), false);
      const launch = JSON.parse(launchText) as { workerId: string; piSessionId: string };
      await writeFile(
        join(stateDirectory, "resources.json"),
        JSON.stringify({
          workerId: launch.workerId,
          vmId: "vm-chatgpt",
          effectiveRoute: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "medium" },
        }),
      );
    },
  };
  const runtime = await createNativeChatGptRuntime({
    cwd: "/consumer",
    workspaceId: "workspace-1",
    stateRoot,
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
      calls.push("verify-route");
    },
    async onWorkerOwned(observation) {
      assert.equal(observation.identity.vmId, "vm-chatgpt");
      await assert.rejects(access(join(stateDirectory, "dispatch.json")));
      calls.push("record-owner");
    },
  });

  const worker = await runtime.launch({
    taskId: "task-chatgpt",
    assignmentId: "assignment-chatgpt",
    question: "Which module owns cleanup?",
    provider: "openai-codex",
    transport: "sse",
    cacheWarming: "off",
    allowedHosts: ["chatgpt.com"],
    allowWebSockets: false,
    focus: false,
    hostMounts: [],
    inheritHostEnvironment: false,
    tabLabel: "PI Lead · ChatGPT read-only worker",
  });
  const launch = JSON.parse(await readFile(join(stateDirectory, "launch.json"), "utf8")) as {
    modelId: string;
    reasoning: string;
    piSessionId: string;
    policy: unknown;
  };
  assert.equal(launch.modelId, "gpt-5.6-luna");
  assert.equal(launch.reasoning, "high");
  assert.equal(launch.piSessionId, worker.piSessionId);
  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, "dispatch.json"), "utf8")), { admitted: true });
  assert.deepEqual(launch.policy, {
    provider: "openai-codex",
    transport: "sse",
    cacheWarming: "off",
    allowedHosts: ["chatgpt.com"],
    allowWebSockets: false,
    hostMounts: [],
    inheritHostEnvironment: false,
  });

  await writeFile(
    join(stateDirectory, "result.json"),
    JSON.stringify({
      ...worker,
      status: "answered",
      output: "The trusted host controller owns cleanup.",
      nativeEvents: ["agent_start", "message_end", "agent_end"],
      stopReason: "stop",
    }),
  );
  const result = await runtime.waitForResult(worker);
  assert.equal(result.status, "answered");
  if (result.status === "answered") {
    assert.equal(result.output, "The trusted host controller owns cleanup.");
    assert.deepEqual(result.nativeEvents, ["agent_start", "message_end", "agent_end"]);
    assert.ok((await runtime.collectResult(result)).artifactId);
  }

  await writeFile(
    join(stateDirectory, "termination.json"),
    JSON.stringify({ vmId: worker.vmId, terminated: true }),
  );
  assert.deepEqual(await runtime.terminate(worker), { vmId: worker.vmId, terminated: true });
  await runtime.closeSuccessfulTab(worker.tabId);
  assert.deepEqual(calls, ["create-tab", "start-launcher", "verify-route", "record-owner", "close-tab"]);
});
