import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLeadExtension } from "../src/lead.ts";
import type { FixtureRequest, FixtureSummary } from "../src/task-lifecycle.ts";

test("the Lead fixture command delegates once and records its correlated summary", async () => {
  let command:
    | {
        description?: string;
        handler: (args: string, context: unknown) => Promise<void>;
      }
    | undefined;
  const entries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let receivedRequest: FixtureRequest | undefined;

  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(name: string, definition: typeof command) {
      assert.equal(name, "lead-fixture");
      command = definition;
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  const extension = createLeadExtension({
    async runFixture(request) {
      receivedRequest = request;
      return {
        status: "DONE",
        ...request,
        workerId: "worker-command",
        vmId: "vm-command",
        tabId: "tab-command",
        artifactId: "artifact-command",
        output: "fixture complete",
        vmTerminated: true,
      } satisfies FixtureSummary;
    },
  });
  extension(pi);

  assert.match(command?.description ?? "", /isolated fixture/i);
  await command?.handler("", {
    cwd: "/consumer",
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  assert.ok(receivedRequest?.taskId);
  assert.ok(receivedRequest?.assignmentId);
  assert.notEqual(receivedRequest?.taskId, receivedRequest?.assignmentId);
  assert.deepEqual(entries, [
    {
      type: "pi-lead:fixture-summary",
      data: {
        status: "DONE",
        ...receivedRequest,
        workerId: "worker-command",
        vmId: "vm-command",
        tabId: "tab-command",
        artifactId: "artifact-command",
        output: "fixture complete",
        vmTerminated: true,
      },
    },
  ]);
  assert.deepEqual(notifications, [
    { message: "PI Lead fixture: DONE — fixture complete", level: "info" },
  ]);
});

test("the Lead admits at most two fixture workers concurrently", async () => {
  let handler: ((args: string, context: unknown) => Promise<void>) | undefined;
  const entries: unknown[] = [];
  const releases: Array<() => void> = [];
  let runCount = 0;
  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(_name: string, definition: { handler: typeof handler }) {
      handler = definition.handler;
    },
    appendEntry(_type: string, data: unknown) {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture(request) {
      runCount++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        status: "DONE",
        ...request,
        workerId: `worker-${runCount}`,
        vmId: `vm-${runCount}`,
        tabId: `tab-${runCount}`,
        artifactId: `artifact-${runCount}`,
        output: "fixture complete",
        vmTerminated: true,
      };
    },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify() {} } };

  const first = handler?.("", context);
  const second = handler?.("", context);
  await handler?.("", context);

  assert.equal(runCount, 2);
  assert.equal(
    entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "reason" in entry &&
        entry.reason === "CONCURRENCY_LIMIT",
    ),
    true,
  );
  for (const release of releases) release();
  await Promise.all([first, second]);
});
