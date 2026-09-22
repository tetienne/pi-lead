import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLeadExtension } from "../src/lead.ts";
import type { CompleteLocalCodingRequest } from "../src/review-fix-commit-task.ts";
import type { WorkerRouteAuthorization } from "../src/lead.ts";

test("/lead reserves review capacity and records a delivered local commit", async () => {
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
    async routeIntent() {
      return { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" };
    },
  })(pi);

  await commands.get("lead")?.(
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
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", new RegExp(`committed ${"b".repeat(40)} on pi-lead/task-task-4`));
  assert.match(notifications[0]?.message ?? "", /checks none reported; review none reported; route legacy; cleanup confirmed; publication deferred/);
  assert.equal(notifications[0]?.level, "info");
});

test("a unified implementation verifies the effective model and reasoning at worker spawn", async () => {
  const commands = new Map<string, (args: string, context: any) => Promise<void>>();
  const entries: Array<{ type: string; data: any }> = [];
  const state = {
    version: 1,
    activeWorkers: 0,
    maxActiveWorkers: 2,
    providers: {
      "openai-codex": { authenticated: true, quotaAvailable: true },
      "opencode-go": { authenticated: false, quotaAvailable: false },
    },
    availableModels: {
      "openai-codex": ["gpt-5.6-luna"],
      "opencode-go": [],
    },
    budgetAvailable: true,
    minimumConfidence: 0.8,
    routes: [{
      provider: "openai-codex" as const,
      modelId: "gpt-5.6-luna",
      reasoning: "high" as const,
      allowedEffectiveReasoning: ["medium", "high"] as const,
      taskClasses: ["DEMANDING"] as const,
      contextClasses: ["STANDARD", "LARGE"] as const,
    }],
  };
  const judgment = {
    questionId: "worker-resource" as const,
    type: "resource" as const,
    stateVersion: 1,
    taskClass: "DEMANDING" as const,
    contextClass: "STANDARD" as const,
    confidence: 1,
  };
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: (args: string, context: any) => Promise<void> }) {
      commands.set(name, definition.handler);
    },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async authorizeWorkerRoute(): Promise<WorkerRouteAuthorization> {
      return {
        state,
        judgment,
      };
    },
    async runCompleteLocalCoding(request, _cwd, _signal, route) {
      assert.equal(route?.selection.modelId, "gpt-5.6-luna");
      assert.deepEqual(route?.verifySpawn({
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        reasoning: "medium",
      }), {
        status: "VERIFIED",
        selection: route?.selection,
        effectiveReasoning: "medium",
        clamped: true,
      });
      return {
        status: "DONE",
        taskId: request.taskId,
        proposal: {
          status: "REVIEW_REQUIRED", taskId: request.taskId, assignmentId: "build",
          workerId: "worker", vmId: "vm", tabId: "tab", paneId: "pane", piSessionId: "session",
          baseCommit: "a".repeat(40), proposedCommit: "b".repeat(40), validations: [], artifactId: "artifact",
          files: [], humanGate: true, hostCommitted: false, published: false, vmTerminated: true,
        },
        reviews: [], reviewHistory: [], reviewCycles: 0,
        commit: { branchName: `pi-lead/task-${request.taskId}`, commit: "b".repeat(40), committed: true, activeCheckoutPreserved: true },
        published: false, specification: request.specification, standards: request.standards,
      };
    },
    async routeIntent() {
      return { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" };
    },
  })(pi);

  await commands.get("lead")?.(
    "--base main --check test --spec .scratch/pi-lead/issues/18-unified-orchestration.md -- Complete orchestration.",
    { cwd: process.cwd(), ui: { notify() {} } },
  );

  assert.equal(entries[0]?.type, "pi-lead:complete-task-summary");
  assert.deepEqual(entries[0]?.data.workerRoutes, [{
    status: "VERIFIED",
    selection: {
      provider: "openai-codex", modelId: "gpt-5.6-luna", reasoning: "high",
      allowedEffectiveReasoning: ["medium", "high"], fallback: false,
    },
    effectiveReasoning: "medium",
    clamped: true,
  }]);
});

test("an unavailable worker route records a precise BLOCKED implementation outcome", async () => {
  const commands = new Map<string, (args: string, context: any) => Promise<void>>();
  const entries: Array<{ type: string; data: any }> = [];
  let ran = false;
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: (args: string, context: any) => Promise<void> }) {
      commands.set(name, definition.handler);
    },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async authorizeWorkerRoute() { throw new Error("worker route NO_ADEQUATE_ROUTE"); },
    async runCompleteLocalCoding() { ran = true; throw new Error("must not run"); },
    async routeIntent() {
      return { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" };
    },
  })(pi);

  await commands.get("lead")?.(
    "--base main --check test --spec .scratch/pi-lead/issues/18-unified-orchestration.md -- Complete orchestration.",
    { cwd: process.cwd(), ui: { notify() {} } },
  );

  assert.equal(ran, false);
  assert.equal(entries[0]?.type, "pi-lead:complete-task-summary");
  assert.equal(entries[0]?.data.status, "BLOCKED");
  assert.equal(entries[0]?.data.reason, "BUILD_BLOCKED");
  assert.match(entries[0]?.data.detail, /NO_ADEQUATE_ROUTE/);
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
    async routeIntent() {
      return { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" };
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
  const first = commands.get("lead")?.(args, context);
  await firstStartedPromise;
  const second = commands.get("lead")?.(args, context);
  await queuedPromise;
  assert.equal(started.length, 1);
  assert.equal(notifications.some((message) => message.includes("QUEUED")), true);
  releases.shift()?.();
  await secondStartedPromise;
  assert.equal(started.length, 2);
  releases.shift()?.();
  await Promise.all([first, second]);
});
