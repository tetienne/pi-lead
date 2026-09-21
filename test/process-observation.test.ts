import assert from "node:assert/strict";
import { test } from "node:test";

import { observeProcessExit } from "../src/process-observation.ts";

test("confirms VM termination only after the captured host PID disappears", async () => {
  const observations = [true, true, false];
  const terminated = await observeProcessExit(4242, 100, 1, (pid) => {
    assert.equal(pid, 4242);
    return observations.shift() ?? false;
  });

  assert.equal(terminated, true);
  assert.deepEqual(observations, []);
});

test("does not confirm termination while the captured host PID is still alive", async () => {
  const terminated = await observeProcessExit(4242, 0, 1, () => true);
  assert.equal(terminated, false);
});

test("does not claim termination when Gondolin supplied no host PID to observe", async () => {
  const terminated = await observeProcessExit(null, 100, 1, () => false);
  assert.equal(terminated, false);
});
