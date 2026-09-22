import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDeliveredVerificationBase } from "../src/native-debug-review-runtime.ts";

test("debug verification remains pinned to the exact delivered commit", () => {
  const delivered = "a".repeat(40);
  assert.doesNotThrow(() => assertDeliveredVerificationBase(delivered, delivered));
  assert.throws(
    () => assertDeliveredVerificationBase("b".repeat(40), delivered),
    /delivery branch moved before verification/i,
  );
});
