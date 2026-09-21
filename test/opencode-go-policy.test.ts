import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENCODE_GO_API_KEY_ENV,
  classifyOpenCodeGoFailure,
  createOpenCodeGoMediation,
} from "../src/opencode-go-policy.ts";

function request(environment: Record<string, string>, sessionId = "session-1"): Request {
  return new Request("https://opencode.ai/zen/go/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment[OPENCODE_GO_API_KEY_ENV]}`,
      "x-opencode-session": sessionId,
      "x-opencode-client": "pi",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

test("OpenCode Go retains native Pi attribution and substitutes its host-held key only at its native endpoint", async () => {
  const mediation = createOpenCodeGoMediation({
    apiKey: "host-go-key",
    sessionId: "session-1",
    placeholderNonce: "worker-1",
  });
  assert.deepEqual(mediation.allowedHosts, ["opencode.ai"]);
  assert.notEqual(mediation.guestEnvironment[OPENCODE_GO_API_KEY_ENV], "host-go-key");
  const outgoing = await mediation.httpHooks.onRequest?.(request(mediation.guestEnvironment));
  assert.ok(outgoing instanceof Request);
  assert.equal(outgoing.headers.get("authorization"), "Bearer host-go-key");
  assert.equal(outgoing.headers.get("x-opencode-session"), "session-1");
  assert.equal(outgoing.headers.get("x-opencode-client"), "pi");
  assert.equal(await mediation.httpHooks.isRequestAllowed?.(outgoing), true);
});

test("OpenCode Go rejects alternate destinations and forged native attribution", async () => {
  const mediation = createOpenCodeGoMediation({ apiKey: "host-go-key", sessionId: "session-1", placeholderNonce: "worker-1" });
  const env = mediation.guestEnvironment;
  assert.equal(await mediation.httpHooks.isRequestAllowed?.(new Request("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST" })), false);
  assert.equal(await mediation.httpHooks.isRequestAllowed?.(request(env, "wrong-session")), false);
  const redirect = await mediation.httpHooks.onResponse?.(new Response(null, { status: 307 }), request(env));
  assert.equal(redirect?.status, 502);
});

test("OpenCode Go allowance exhaustion is terminal and never selects a paid fallback", () => {
  assert.equal(classifyOpenCodeGoFailure("Your included allowance is exhausted; enable balance to continue"), "QUOTA_EXHAUSTED");
  assert.equal(classifyOpenCodeGoFailure("model example is unavailable"), "MODEL_UNAVAILABLE");
});

test("OpenCode Go blocks a host key reflected across response chunks", async () => {
  const mediation = createOpenCodeGoMediation({ apiKey: "host-go-key", sessionId: "session-1", placeholderNonce: "worker-1" });
  const encoded = new TextEncoder();
  const response = await mediation.httpHooks.onResponse?.(new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoded.encode("safe host-")); controller.enqueue(encoded.encode("go-key")); controller.close(); },
  })), request(mediation.guestEnvironment));
  await assert.rejects(() => response?.text() ?? Promise.resolve(), /credential-bearing/i);
  assert.match(mediation.getLastPolicyRejection() ?? "", /reflect/i);
});
