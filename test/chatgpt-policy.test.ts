import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHATGPT_ACCOUNT_ENV,
  CHATGPT_TOKEN_ENV,
  createChatGptMediation,
  type ChatGptCredential,
} from "../src/chatgpt-policy.ts";

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function providerRequest(environment: Record<string, string>, overrides: RequestInit = {}): Request {
  return new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${environment[CHATGPT_TOKEN_ENV]}`,
      "chatgpt-account-id": environment[CHATGPT_ACCOUNT_ENV] ?? "",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      ...Object.fromEntries(new Headers(overrides.headers).entries()),
    },
    body: "{}",
    ...overrides,
  });
}

test("ChatGPT mediation exposes only a parseable synthetic identity and pins Pi to SSE without cache warming", () => {
  const realCredential = {
    accessToken: "real-access-token",
    accountId: "real-account-id",
  } satisfies ChatGptCredential;
  const mediation = createChatGptMediation({
    initialCredential: realCredential,
    async refreshCredential() {
      return realCredential;
    },
    placeholderNonce: "nonce-one",
  });

  const placeholderToken = mediation.guestEnvironment[CHATGPT_TOKEN_ENV];
  const placeholderAccount = mediation.guestEnvironment[CHATGPT_ACCOUNT_ENV];
  assert.ok(placeholderToken);
  assert.ok(placeholderAccount);
  assert.notEqual(placeholderToken, realCredential.accessToken);
  assert.notEqual(placeholderAccount, realCredential.accountId);
  assert.deepEqual(decodePayload(placeholderToken), {
    "https://api.openai.com/auth": { chatgpt_account_id: placeholderAccount },
  });
  assert.deepEqual(mediation.providerOverlay, {
    providers: { "openai-codex": { apiKey: `$${CHATGPT_TOKEN_ENV}` } },
  });
  assert.deepEqual(mediation.settings, {
    cacheWarming: "off",
    transport: "sse",
  });
  assert.deepEqual(mediation.allowedHosts, ["chatgpt.com"]);
  assert.equal(JSON.stringify(mediation.guestEnvironment).includes(realCredential.accessToken), false);
  assert.equal(JSON.stringify(mediation.guestEnvironment).includes(realCredential.accountId), false);
});

test("ChatGPT mediation refreshes on the host and injects credentials only into the exact native SSE request", async () => {
  const initial = { accessToken: "old-token", accountId: "old-account" };
  const refreshed = { accessToken: "fresh-token", accountId: "fresh-account" };
  let refreshes = 0;
  const mediation = createChatGptMediation({
    initialCredential: initial,
    async refreshCredential() {
      refreshes++;
      return refreshed;
    },
    placeholderNonce: "nonce-two",
  });
  const request = providerRequest(mediation.guestEnvironment);

  assert.equal(await mediation.httpHooks.isRequestAllowed?.(request), true);
  const injected = await mediation.httpHooks.onRequest?.(request.clone());
  assert.ok(injected instanceof Request);
  assert.equal(injected.headers.get("authorization"), `Bearer ${refreshed.accessToken}`);
  assert.equal(injected.headers.get("chatgpt-account-id"), refreshed.accountId);
  assert.equal(await mediation.httpHooks.isRequestAllowed?.(injected), true);
  assert.equal(refreshes, 1);
  assert.equal(JSON.stringify([...injected.headers]).includes(initial.accessToken), false);
});

test("ChatGPT mediation rejects alternate endpoints, methods, queries, misplaced placeholders, and redirects", async () => {
  const credential = { accessToken: "host-token", accountId: "host-account" };
  const mediation = createChatGptMediation({
    initialCredential: credential,
    async refreshCredential() {
      return credential;
    },
    placeholderNonce: "nonce-three",
  });
  const environment = mediation.guestEnvironment;
  const denied = [
    new Request("http://chatgpt.com/backend-api/codex/responses", { method: "POST" }),
    new Request("https://chatgpt.com/backend-api/other", { method: "POST" }),
    new Request("https://chatgpt.com/backend-api/codex/responses?leak=1", { method: "POST" }),
    providerRequest(environment, { method: "GET", body: undefined }),
    providerRequest(environment, {
      headers: { "x-copy": environment[CHATGPT_TOKEN_ENV] ?? "" },
    }),
  ];

  for (const request of denied) {
    assert.equal(await mediation.httpHooks.isRequestAllowed?.(request), false, request.url);
  }

  const redirect = await mediation.httpHooks.onResponse?.(
    new Response(null, { status: 307, headers: { location: "https://example.com/collect" } }),
    providerRequest(environment),
  );
  assert.ok(redirect instanceof Response);
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.has("location"), false);
});

test("a host refresh failure stops credential injection with a useful provider error", async () => {
  const mediation = createChatGptMediation({
    initialCredential: { accessToken: "host-token", accountId: "host-account" },
    async refreshCredential() {
      throw new Error("ChatGPT login expired");
    },
    placeholderNonce: "nonce-four",
  });

  await assert.rejects(
    async () => mediation.httpHooks.onRequest?.(providerRequest(mediation.guestEnvironment)),
    /ChatGPT credential refresh failed: ChatGPT login expired/,
  );
});

test("concurrent workers rotate bearer and account identity as one credential pair", async () => {
  const refreshed = [
    { accessToken: "worker-a-token", accountId: "worker-a-account" },
    { accessToken: "worker-b-token", accountId: "worker-b-account" },
  ];
  let nextCredential = 0;
  const refreshCredential = async () => {
    const credential = refreshed[nextCredential++];
    assert.ok(credential);
    return credential;
  };
  const workers = ["worker-a", "worker-b"].map((nonce) =>
    createChatGptMediation({
      initialCredential: { accessToken: `${nonce}-old-token`, accountId: `${nonce}-old-account` },
      refreshCredential,
      placeholderNonce: nonce,
    }),
  );

  const injected = await Promise.all(
    workers.map((worker) =>
      worker.httpHooks.onRequest?.(providerRequest(worker.guestEnvironment)),
    ),
  );

  assert.deepEqual(
    injected.map((request) => [
      request?.headers.get("authorization"),
      request?.headers.get("chatgpt-account-id"),
    ]),
    refreshed.map((credential) => [`Bearer ${credential.accessToken}`, credential.accountId]),
  );
});

test("credential bytes reflected across response chunks are blocked before reaching the guest", async () => {
  const credential = {
    accessToken: "host-token-that-must-never-reach-the-guest",
    accountId: "host-account-that-must-stay-host-only",
  };
  const mediation = createChatGptMediation({
    initialCredential: credential,
    async refreshCredential() {
      return credential;
    },
    placeholderNonce: "nonce-reflection",
  });
  const encoded = new TextEncoder();
  const reflected = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.encode(`event: response.created\ndata: safe\n\n${credential.accessToken.slice(0, 13)}`));
      controller.enqueue(encoded.encode(`${credential.accessToken.slice(13)}\n`));
      controller.close();
    },
  });
  const guarded = await mediation.httpHooks.onResponse?.(
    new Response(reflected, { status: 200, headers: { "content-type": "text/event-stream" } }),
    providerRequest(mediation.guestEnvironment),
  );
  assert.ok(guarded instanceof Response);

  const reader = guarded.body?.getReader();
  assert.ok(reader);
  const delivered: Uint8Array[] = [];
  await assert.rejects(async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      delivered.push(chunk.value);
    }
  }, /credential-bearing response body/i);
  const deliveredText = Buffer.concat(delivered).toString("utf8");
  assert.equal(deliveredText.includes(credential.accessToken), false);
  assert.equal(deliveredText.includes(credential.accessToken.slice(0, 13)), false);
});
