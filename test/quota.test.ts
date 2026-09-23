import assert from "node:assert/strict";
import { test } from "node:test";

import { providerOf, quotaError, quotaPauseMinutes } from "../src/quota.ts";

test("ChatGPT and OpenCode Go limits are quota errors; transient failures are not", () => {
  assert.deepEqual(quotaError("You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min."), {
    message: "You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min.",
    retryAfterMinutes: 42,
  });
  assert.deepEqual(quotaError('429 {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}')?.retryAfterMinutes, undefined);
  assert.ok(quotaError("Monthly usage limit reached. Enable available balance to continue."));
  assert.ok(quotaError("insufficient_quota"));
  assert.equal(quotaError("529 overloaded"), undefined);
  assert.equal(quotaError("fetch failed"), undefined);
  assert.equal(providerOf("opencode-go/glm-5.3"), "opencode-go");
});

test("a quota pause is never shorter than five minutes, and short when ChatGPT gives no reset time", () => {
  assert.equal(quotaPauseMinutes({ message: "You have hit your ChatGPT usage limit (pro plan). Try again in ~0 min.", retryAfterMinutes: 0 }), 5);
  assert.equal(quotaPauseMinutes({ message: "x", retryAfterMinutes: 90 }), 90);
  assert.equal(quotaPauseMinutes({ message: "You have hit your ChatGPT usage limit (pro plan)." }), 5, "may be a plain 429 rate limit");
  assert.equal(quotaPauseMinutes({ message: "GoUsageLimitError: Go usage limit exceeded" }), 60);
});
