import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recoverNativeInterruptedTasks } from "../src/native-task-recovery.ts";

test("native recovery admits a project with no interrupted durable tasks without external probes", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-lead-native-recovery-"));

  assert.deepEqual(await recoverNativeInterruptedTasks({ cwd: process.cwd(), stateRoot }), []);
});
