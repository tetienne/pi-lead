import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLeadExtension } from "../src/lead.ts";
import type {
  ProposedChangeRequest,
  ReviewRequiredSummary,
} from "../src/proposed-change-task.ts";
import type { CompleteLocalCodingRequest } from "../src/review-fix-commit-task.ts";

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

test("the Lead implement command reserves review capacity and records a delivered local commit", async () => {
  const commands = new Map<string, (args: string, context: any) => Promise<void>>();
  const requests: CompleteLocalCodingRequest[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(name: string, definition: { handler: (args: string, context: any) => Promise<void> }) {
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
    async runCompleteLocalCoding(request) {
      requests.push(request);
      return {
        status: "DONE",
        taskId: request.taskId,
        proposal: {
          status: "REVIEW_REQUIRED",
          taskId: request.taskId,
          assignmentId: "build",
          workerId: "worker",
          vmId: "vm",
          tabId: "tab",
          paneId: "pane",
          piSessionId: "session",
          baseCommit: "a".repeat(40),
          proposedCommit: "b".repeat(40),
          validations: [],
          artifactId: "artifact",
          files: [],
          humanGate: true,
          hostCommitted: false,
          published: false,
          vmTerminated: true,
        },
        reviews: [],
        reviewHistory: [],
        reviewCycles: 0,
        commit: {
          branchName: "pi-lead/task-task-4",
          commit: "b".repeat(40),
          committed: true,
          activeCheckoutPreserved: true,
        },
        published: false,
        specification: request.specification,
        standards: request.standards,
      };
    },
  })(pi);

  await commands.get("lead-implement")?.(
    "--base main --check test --allow registry.npmjs.org --spec .scratch/pi-lead/issues/04-review-fix-commit.md -- Update the value.",
    {
      cwd: process.cwd(),
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  );

  assert.equal(requests[0]?.repositoryPath, process.cwd());
  assert.equal(requests[0]?.namedBase, "main");
  assert.deepEqual(requests[0]?.validationTasks, ["test"]);
  assert.deepEqual(requests[0]?.dependencyHosts, ["registry.npmjs.org"]);
  assert.equal(requests[0]?.instruction, "Update the value.");
  assert.equal(requests[0]?.specification.source, ".scratch/pi-lead/issues/04-review-fix-commit.md");
  assert.match(requests[0]?.specification.digest ?? "", /^[0-9a-f]{64}$/);
  assert.match(requests[0]?.standards.digest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(entries[0]?.type, "pi-lead:complete-task-summary");
  assert.deepEqual(notifications, [
    {
      message: `PI Lead implement: DONE — committed ${"b".repeat(40)} on pi-lead/task-task-4`,
      level: "info",
    },
  ]);
});

test("an implementation waiting for its two review slots is queued until the current task releases them", async () => {
  const commands = new Map<string, (args: string, context: any) => Promise<void>>();
  const releases: Array<() => void> = [];
  const started: string[] = [];
  let firstStarted: (() => void) | undefined;
  let secondStarted: (() => void) | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondStartedPromise = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const notifications: string[] = [];
  let queued: (() => void) | undefined;
  const queuedPromise = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(name: string, definition: { handler: (args: string, context: any) => Promise<void> }) {
      commands.set(name, definition.handler);
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() {
      throw new Error("fixture should not run");
    },
    async runCompleteLocalCoding(request) {
      started.push(request.taskId);
      firstStarted?.();
      firstStarted = undefined;
      if (started.length === 2) secondStarted?.();
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        status: "BLOCKED" as const,
        taskId: request.taskId,
        reason: "BUILD_BLOCKED" as const,
        detail: "fixture complete",
        reviews: [],
        reviewHistory: [],
        reviewCycles: 0,
        diagnosticsRetained: true as const,
        specification: request.specification,
        standards: request.standards,
      };
    },
  })(pi);
  const context = {
    cwd: process.cwd(),
    ui: {
      notify(message: string) {
        notifications.push(message);
        if (message.includes("QUEUED")) queued?.();
      },
    },
  };
  const args = "--base main --check test --spec .scratch/pi-lead/issues/04-review-fix-commit.md -- Update the value.";
  const first = commands.get("lead-implement")?.(args, context);
  await firstStartedPromise;
  const second = commands.get("lead-implement")?.(args, context);
  await queuedPromise;
  assert.equal(started.length, 1);
  assert.equal(notifications.some((message) => message.includes("QUEUED")), true);
  releases.shift()?.();
  await secondStartedPromise;
  assert.equal(started.length, 2);
  releases.shift()?.();
  await Promise.all([first, second]);
});
