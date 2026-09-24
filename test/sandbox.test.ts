import assert from "node:assert/strict";
import { test } from "node:test";

import { guestEnv } from "../src/sandbox.ts";

test("guestEnv carries safe.directory config for the host-mounted workspace", () => {
  for (const env of [guestEnv(false), guestEnv(true)]) {
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "safe.directory");
    assert.equal(env.GIT_CONFIG_VALUE_0, "*");
  }
});
