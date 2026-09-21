import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLeadExtension } from "../src/lead.ts";
import type {
  ProposedChangeRequest,
  ReviewRequiredSummary,
} from "../src/proposed-change-task.ts";

test("the Lead change command records a review-required proposal without calling it done", async () => {
  const commands = new Map<string, (args: string, context: unknown) => Promise<void>>();
  const requests: ProposedChangeRequest[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(
      name: string,
      definition: { handler: (args: string, context: unknown) => Promise<void> },
    ) {
      commands.set(name, definition.handler);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() {
      throw new Error("fixture should not run");
    },
    async runProposedChange(request) {
      requests.push(request);
      return {
        status: "REVIEW_REQUIRED",
        ...request,
        workerId: "worker-change",
        vmId: "vm-change",
        tabId: "tab-change",
        paneId: "pane-change",
        piSessionId: "session-change",
        baseCommit: "1".repeat(40),
        proposedCommit: "2".repeat(40),
        validations: [
          { task: "test", command: "mise run test", passed: true, exitCode: 0 },
        ],
        artifactId: "artifact-change",
        files: [],
        humanGate: true,
        hostCommitted: false,
        published: false,
        vmTerminated: true,
      } satisfies ReviewRequiredSummary;
    },
  })(pi);

  await commands.get("lead-change")?.(
    "--base main --check test --allow registry.npmjs.org -- Update the value.",
    {
      cwd: "/consumer",
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    taskId: requests[0]?.taskId,
    assignmentId: requests[0]?.assignmentId,
    instruction: "Update the value.",
    repositoryPath: "/consumer",
    namedBase: "main",
    validationTasks: ["test"],
    dependencyHosts: ["registry.npmjs.org"],
  });
  assert.equal(entries[0]?.type, "pi-lead:proposed-change-summary");
  assert.deepEqual(notifications, [
    {
      message: "PI Lead change: REVIEW_REQUIRED — 0 file(s), validated; human review required",
      level: "info",
    },
  ]);
});
