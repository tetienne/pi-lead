import assert from "node:assert/strict";
import { test } from "node:test";

import { guestEnv, serviceEnv, serviceHosts } from "../src/sandbox.ts";

test("guestEnv carries safe.directory config for the host-mounted workspace", () => {
  for (const env of [guestEnv(false), guestEnv(true)]) {
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "safe.directory");
    assert.equal(env.GIT_CONFIG_VALUE_0, "*");
  }
});

test("serviceHosts maps each service's name:port to its relay on 127.0.0.1", () => {
  assert.deepEqual(
    serviceHosts([
      { name: "postgres", port: 5432, hostPort: 54_321 },
      { name: "redis", port: 6379, hostPort: 63_790 },
    ]),
    { "postgres:5432": "127.0.0.1:54321", "redis:6379": "127.0.0.1:63790" },
  );
  assert.deepEqual(serviceHosts([]), {});
});

test("serviceEnv names each service PI_LEAD_SERVICE_<NAME> with dashes as underscores", () => {
  assert.deepEqual(serviceEnv([{ name: "my-db", port: 5432, hostPort: 54_321 }]), { PI_LEAD_SERVICE_MY_DB: "my-db:5432" });
});
