import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createNativePiCredentialSource,
  extractChatGptCredential,
  parsePiJsonResult,
} from "../src/chatgpt-worker-host.ts";

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("native Pi JSON evidence yields only the authoritative assistant result for the expected session", () => {
  const stdout = [
    line({ type: "session", version: 3, id: "session-1", cwd: "/workspace" }),
    line({ type: "agent_start" }),
    line({ type: "message_end", message: { role: "user", content: "question" } }),
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "authoritative answer" }],
        stopReason: "stop",
      },
    }),
    line({ type: "agent_end", messages: [] }),
  ].join("\n");

  assert.deepEqual(parsePiJsonResult(stdout, "session-1"), {
    status: "answered",
    output: "authoritative answer",
    stopReason: "stop",
    nativeEvents: ["agent_start", "message_end", "agent_end"],
  });
  assert.throws(() => parsePiJsonResult(stdout, "stale-session"), /session identity/i);
});

test("native Pi provider errors map quota, refresh, and model failures without fallback", () => {
  for (const [message, failure] of [
    ["You have hit your ChatGPT usage limit (pro plan).", "QUOTA_EXHAUSTED"],
    ["ChatGPT credential refresh failed: login expired", "REFRESH_FAILED"],
    ["Model gpt-missing is unavailable", "MODEL_UNAVAILABLE"],
  ] as const) {
    const stdout = [
      line({ type: "session", id: "session-1" }),
      line({ type: "agent_start" }),
      line({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: message },
      }),
      line({ type: "agent_end", messages: [] }),
    ].join("\n");
    assert.deepEqual(parsePiJsonResult(stdout, "session-1"), {
      status: "failed",
      failure,
      detail: message,
      nativeEvents: ["agent_start", "message_end", "agent_end"],
    });
  }
});

test("host OAuth extraction returns only the bearer and account identity required by mediation", () => {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
      unrelated: "must not be copied",
    }),
  ).toString("base64url");
  const accessToken = `header.${payload}.signature`;

  assert.deepEqual(extractChatGptCredential({ auth: { apiKey: accessToken }, source: "OAuth" }), {
    accessToken,
    accountId: "account-1",
  });
  assert.throws(
    () => extractChatGptCredential({ auth: {}, source: "OAuth" }),
    /bearer token is unavailable/i,
  );
});

test("native credential setup refreshes local auth state before asserting subscription mode", async () => {
  let refreshOnCreate: boolean | undefined;
  const source = await createNativePiCredentialSource(undefined, async (options) => {
    refreshOnCreate = options.refreshOnCreate;
    return {
      isUsingSubscription() {
        return options.refreshOnCreate;
      },
      getModel() {
        return {} as never;
      },
      async getAuth() {
        return {
          auth: {
            apiKey: `header.${Buffer.from(
              JSON.stringify({
                "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
              }),
            ).toString("base64url")}.signature`,
          },
          source: "OAuth",
        };
      },
    };
  });

  assert.equal(refreshOnCreate, true);
  assert.deepEqual(await source.getCredential(), {
    accessToken: `header.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
    ).toString("base64url")}.signature`,
    accountId: "account-1",
  });
});
