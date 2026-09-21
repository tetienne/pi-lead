import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runReadOnlyChatGptTask,
  type ChatGptTaskRuntime,
  type ChatGptWorker,
} from "../src/chatgpt-task.ts";

function ownedWorker(): ChatGptWorker {
  return {
    taskId: "task-chatgpt",
    assignmentId: "assignment-chatgpt",
    workerId: "worker-chatgpt",
    vmId: "vm-chatgpt",
    tabId: "tab-chatgpt",
    paneId: "pane-chatgpt",
    piSessionId: "session-chatgpt",
  };
}

test("a read-only worker succeeds only after an attributable native Pi answer is collected and cleanup is confirmed", async () => {
  const calls: string[] = [];
  const worker = ownedWorker();
  const runtime: ChatGptTaskRuntime = {
    async launch(request) {
      calls.push("launch");
      assert.equal(request.question, "Which module owns worker cleanup?");
      assert.equal(request.provider, "openai-codex");
      assert.equal(request.transport, "sse");
      assert.equal(request.cacheWarming, "off");
      assert.deepEqual(request.allowedHosts, ["chatgpt.com"]);
      assert.equal(request.allowWebSockets, false);
      assert.equal(request.focus, false);
      assert.deepEqual(request.hostMounts, []);
      assert.equal(request.inheritHostEnvironment, false);
      return worker;
    },
    async waitForResult(received) {
      calls.push("wait");
      assert.equal(received, worker);
      return {
        ...worker,
        status: "answered",
        output: "The trusted host controller owns worker cleanup.",
        nativeEvents: ["agent_start", "message_end", "agent_end", "agent_settled"],
        stopReason: "stop",
      };
    },
    async collectResult(result) {
      calls.push("collect");
      return { artifactId: "artifact-chatgpt", output: result.output };
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runReadOnlyChatGptTask(
    {
      taskId: worker.taskId,
      assignmentId: worker.assignmentId,
      question: "Which module owns worker cleanup?",
    },
    runtime,
  );

  assert.deepEqual(calls, ["launch", "wait", "collect", "terminate", "close"]);
  assert.deepEqual(summary, {
    status: "DONE",
    taskId: worker.taskId,
    assignmentId: worker.assignmentId,
    workerId: worker.workerId,
    vmId: worker.vmId,
    tabId: worker.tabId,
    paneId: worker.paneId,
    piSessionId: worker.piSessionId,
    artifactId: "artifact-chatgpt",
    output: "The trusted host controller owns worker cleanup.",
    vmTerminated: true,
  });
});

test("agent-settled or terminal idleness without an authoritative native Pi answer cannot complete a task", async () => {
  const worker = ownedWorker();
  const calls: string[] = [];
  const runtime: ChatGptTaskRuntime = {
    async launch() {
      return worker;
    },
    async waitForResult() {
      return {
        ...worker,
        status: "answered",
        output: "unverified screen text",
        nativeEvents: ["agent_settled"],
        stopReason: "stop",
      };
    },
    async collectResult() {
      calls.push("collect");
      throw new Error("must not collect an unverified answer");
    },
    async terminate() {
      calls.push("terminate");
      return { vmId: worker.vmId, terminated: true };
    },
    async closeSuccessfulTab() {
      calls.push("close");
    },
  };

  const summary = await runReadOnlyChatGptTask(
    { taskId: worker.taskId, assignmentId: worker.assignmentId, question: "Question" },
    runtime,
  );

  assert.deepEqual(calls, ["terminate"]);
  assert.equal(summary.status, "BLOCKED");
  if (summary.status === "BLOCKED") {
    assert.equal(summary.reason, "PI_LIFECYCLE_INCOMPLETE");
    assert.equal(summary.vmTerminated, true);
    assert.equal(summary.diagnosticsRetained, true);
  }
});

test("quota, refresh, and unavailable-model failures stop without a paid fallback", async () => {
  for (const failure of ["QUOTA_EXHAUSTED", "REFRESH_FAILED", "MODEL_UNAVAILABLE"] as const) {
    const worker = ownedWorker();
    let terminated = false;
    const runtime: ChatGptTaskRuntime = {
      async launch() {
        return worker;
      },
      async waitForResult() {
        return {
          ...worker,
          status: "failed",
          failure,
          detail: `provider stopped: ${failure}`,
          nativeEvents: ["agent_start", "message_end", "agent_end"],
        };
      },
      async collectResult() {
        throw new Error("failed provider output is diagnostic, not a result");
      },
      async terminate() {
        terminated = true;
        return { vmId: worker.vmId, terminated: true };
      },
      async closeSuccessfulTab() {},
    };

    const summary = await runReadOnlyChatGptTask(
      { taskId: worker.taskId, assignmentId: worker.assignmentId, question: "Question" },
      runtime,
    );

    assert.equal(summary.status, "BLOCKED");
    if (summary.status === "BLOCKED") {
      assert.equal(summary.reason, failure);
      assert.equal(summary.detail, `provider stopped: ${failure}`);
    }
    assert.equal(terminated, true);
  }
});
