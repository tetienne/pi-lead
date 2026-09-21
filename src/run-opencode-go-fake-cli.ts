import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VMOptions } from "@earendil-works/gondolin";

import { runOpenCodeGoWorkerHost } from "./opencode-go-worker-host.ts";
import { writeJsonAtomically } from "./state-files.ts";

function fakeSse(answer: string): string {
  const item = { id: "msg_fake", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] };
  const response = { id: "resp_fake", object: "response", created_at: 1, status: "completed", model: "gpt-5.6-luna", output: [item] };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: answer },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const stateDirectory = await mkdtemp(join(tmpdir(), "pi-lead-opencode-go-fake-"));
const taskId = randomUUID(); const assignmentId = randomUUID(); const workerId = randomUUID(); const piSessionId = randomUUID();
const apiKey = "host-opencode-go-key";
await writeFile(join(stateDirectory, "heartbeat"), new Date().toISOString(), "utf8");
await writeJsonAtomically(join(stateDirectory, "launch.json"), {
  schemaVersion: 1, taskId, assignmentId, workerId, piSessionId, tabId: "fake-tab", paneId: "fake-pane",
  question: "Reply with the fake OpenCode Go answer.", modelId: "gpt-5.6-luna", controllerHeartbeatTimeoutMs: 60_000,
  policy: { provider: "opencode-go", allowedHosts: ["opencode.ai"], allowWebSockets: false, hostMounts: [], inheritHostEnvironment: false },
});
let requests = 0;
const upstreamFetch: NonNullable<VMOptions["fetch"]> = async (input, init) => {
  requests++;
  assert.equal(String(input), "https://opencode.ai/zen/go/v1/responses");
  const headers = new Headers(init?.headers as unknown as HeadersInit);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(headers.get("x-opencode-session"), piSessionId);
  assert.equal(headers.get("x-opencode-client"), "pi");
  return new Response(fakeSse("fake OpenCode Go answer"), { status: 200, headers: { "content-type": "text/event-stream" } }) as unknown as Awaited<ReturnType<NonNullable<VMOptions["fetch"]>>>;
};
await runOpenCodeGoWorkerHost({ stateDirectory, apiKey, overageConfirmedDisabled: true, upstreamFetch });
const result = JSON.parse(await readFile(join(stateDirectory, "result.json"), "utf8")) as { status: string; output: string; nativeEvents: string[]; piSessionId: string };
const termination = JSON.parse(await readFile(join(stateDirectory, "termination.json"), "utf8")) as { terminated: boolean };
assert.equal(requests, 1); assert.equal(result.status, "answered"); assert.equal(result.output, "fake OpenCode Go answer");
assert.equal(result.piSessionId, piSessionId); assert.deepEqual(result.nativeEvents, ["agent_start", "message_end", "agent_end", "agent_settled"]);
assert.equal((await readFile(join(stateDirectory, "runtime.log"), "utf8")).includes(apiKey), false); assert.equal(termination.terminated, true);
process.stdout.write(`${JSON.stringify({ taskId, assignmentId, piSessionId, requests, modelId: "gpt-5.6-luna", output: result.output, vmTerminated: termination.terminated })}\n`);
