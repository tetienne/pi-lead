import { randomUUID } from "node:crypto";

import { createNativeFixtureRuntime } from "./native-runtime.ts";
import { runIsolatedFixture, type FixtureRuntime } from "./task-lifecycle.ts";

const timeoutArgument = process.argv.find((argument) => argument.startsWith("--timeout-ms="));
const timeoutMs = timeoutArgument ? Number(timeoutArgument.slice("--timeout-ms=".length)) : undefined;
if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
  throw new Error("--timeout-ms must be a positive integer");
}
const holdArgument = process.argv.find((argument) => argument.startsWith("--hold-ms="));
const fixtureHoldMs = holdArgument ? Number(holdArgument.slice("--hold-ms=".length)) : undefined;
if (fixtureHoldMs !== undefined && (!Number.isSafeInteger(fixtureHoldMs) || fixtureHoldMs < 0)) {
  throw new Error("--hold-ms must be a non-negative integer");
}

const nativeRuntime = await createNativeFixtureRuntime({ cwd: process.cwd(), fixtureHoldMs });
const runtime: FixtureRuntime = process.argv.includes("--close-tab-after-launch")
  ? {
      ...nativeRuntime,
      async launch(request, signal) {
        const worker = await nativeRuntime.launch(request, signal);
        await nativeRuntime.closeSuccessfulTab(worker.tabId);
        return worker;
      },
    }
  : nativeRuntime;
const summary = await runIsolatedFixture(
  { taskId: randomUUID(), assignmentId: randomUUID() },
  runtime,
  { timeoutMs },
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.status !== "DONE") process.exitCode = 1;
