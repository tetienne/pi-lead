import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VMOptions } from "@earendil-works/gondolin";

import type { ChatGptCredentialSource } from "./chatgpt-worker-host.ts";
import { runChatGptWorkerHost } from "./chatgpt-worker-host.ts";
import { writeJsonAtomically } from "./state-files.ts";

function fakeSse(answer: string): string {
  const item = {
    id: "msg_fake",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  const response = {
    id: "resp_fake",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.6-luna",
    output: [item],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: answer,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: answer,
    },
    {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const stateDirectory = await mkdtemp(join(tmpdir(), "pi-lead-chatgpt-fake-"));
const cancellationMode = process.argv.includes("--cancel");
const reflectionMode = process.argv.includes("--reflect-secret");
const taskId = randomUUID();
const assignmentId = randomUUID();
const workerId = randomUUID();
const piSessionId = randomUUID();
const accessToken = `header.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "host-account-fake" } }),
).toString("base64url")}.signature`;
const accountId = "host-account-fake";
const credentialSource: ChatGptCredentialSource = {
  assertModelAvailable(modelId, reasoning) {
    assert.equal(modelId, "gpt-5.6-luna");
    return reasoning;
  },
  async getCredential() {
    return { accessToken, accountId };
  },
};
let mediatedRequests = 0;
const upstreamFetch: NonNullable<VMOptions["fetch"]> = async (input, init) => {
  mediatedRequests++;
  assert.equal(String(input), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers as unknown as HeadersInit);
  assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(headers.get("chatgpt-account-id"), accountId);
  assert.equal(headers.get("accept"), "text/event-stream");
  return new Response(fakeSse(reflectionMode ? accessToken : "fake isolated answer"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }) as unknown as Awaited<ReturnType<NonNullable<VMOptions["fetch"]>>>;
};

await writeFile(join(stateDirectory, "heartbeat"), new Date().toISOString(), "utf8");
await writeJsonAtomically(join(stateDirectory, "launch.json"), {
  schemaVersion: 1,
  taskId,
  assignmentId,
  question: "Reply with the fake isolated answer.",
  workerId,
  piSessionId,
  tabId: "fake-tab",
  paneId: "fake-pane",
  modelId: "gpt-5.6-luna",
  controllerHeartbeatTimeoutMs: 60_000,
  policy: {
    provider: "openai-codex",
    transport: "sse",
    cacheWarming: "off",
    allowedHosts: ["chatgpt.com"],
    allowWebSockets: false,
    hostMounts: [],
    inheritHostEnvironment: false,
  },
});
let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
if (cancellationMode) {
  cancellationTimer = setTimeout(() => {
    void writeJsonAtomically(join(stateDirectory, "cancel.json"), { reason: "TEST_CANCELLATION" });
  }, 500);
}
await runChatGptWorkerHost({
  stateDirectory,
  credentialSource,
  upstreamFetch,
  debugLog(message) {
    process.stderr.write(`[gondolin] ${message}\n`);
  },
});
if (cancellationTimer) clearTimeout(cancellationTimer);

const runtimeLog = await readFile(join(stateDirectory, "runtime.log"), "utf8");
const termination = JSON.parse(await readFile(join(stateDirectory, "termination.json"), "utf8")) as {
  terminated: boolean;
};
assert.equal(runtimeLog.includes(accessToken), false);
assert.equal(runtimeLog.includes(accountId), false);
assert.equal(termination.terminated, true);

if (cancellationMode) {
  const error = JSON.parse(await readFile(join(stateDirectory, "error.json"), "utf8")) as {
    detail: string;
  };
  assert.equal(mediatedRequests, 0);
  assert.match(error.detail, /Controller requested stop|AbortError|aborted/i);
  process.stdout.write(
    `${JSON.stringify({
      stateDirectory,
      taskId,
      assignmentId,
      mediatedRequests,
      cancellationRecorded: true,
      vmTerminated: termination.terminated,
    })}\n`,
  );
} else if (reflectionMode) {
  const errorText = await readFile(join(stateDirectory, "error.json"), "utf8");
  assert.equal(mediatedRequests, 1);
  assert.equal(errorText.includes(accessToken), false);
  assert.equal(errorText.includes(accountId), false);
  assert.equal(runtimeLog.includes(accessToken.slice(0, 13)), false);
  assert.match(
    errorText,
    /credentials appeared in guest-visible storage|attempted to (?:expose|reflect) host credentials/i,
  );
  process.stdout.write(
    `${JSON.stringify({
      stateDirectory,
      taskId,
      assignmentId,
      mediatedRequests,
      reflectionBlocked: true,
      vmTerminated: termination.terminated,
    })}\n`,
  );
} else {
  const resultText = await readFile(join(stateDirectory, "result.json"), "utf8");
  const result = JSON.parse(resultText) as {
    status: string;
    output: string;
    nativeEvents: string[];
    piSessionId: string;
  };
  assert.equal(mediatedRequests, 1);
  assert.equal(result.status, "answered");
  assert.equal(result.output, "fake isolated answer");
  assert.equal(result.piSessionId, piSessionId);
  assert.deepEqual(result.nativeEvents, ["agent_start", "message_end", "agent_end", "agent_settled"]);
  assert.equal(resultText.includes(accessToken), false);
  assert.equal(resultText.includes(accountId), false);
  process.stdout.write(
    `${JSON.stringify({
      stateDirectory,
      taskId,
      assignmentId,
      piSessionId,
      mediatedRequests,
      nativeEvents: result.nativeEvents,
      output: result.output,
      vmTerminated: termination.terminated,
    })}\n`,
  );
}
