import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredIntentRouter, createLeadExtension } from "../src/lead.ts";
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
      if (name === "lead-fixture") command = definition;
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
    registerCommand(name: string, definition: { handler: typeof handler }) {
      if (name === "lead-fixture") handler = definition.handler;
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

test("natural-language routing keeps chat in Lead and makes ambiguous intake visibly handled", async () => {
  let inputHandler:
    | ((event: { source: string; streamingBehavior?: unknown; images?: unknown[]; text: string }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() {
      throw new Error("not used");
    },
    async routeIntent(input) {
      assert.equal(input, "this is both a bug report and a request to implement it");
      return { status: "CLARIFICATION_REQUIRED", reason: "AMBIGUOUS_INTENT" };
    },
  })(pi);

  assert.deepEqual(
    await inputHandler?.(
      { source: "user", text: "this is both a bug report and a request to implement it" },
      { cwd: "/consumer", ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } },
    ),
    { action: "handled" },
  );
  assert.deepEqual(notifications, [{
    message: "PI Lead intent: clarification required; no worker was started",
    level: "info",
  }]);
});

test("natural-language routing sends triage and wayfinding requests to their Matt workflows", async () => {
  let inputHandler:
    | ((event: { source: string; streamingBehavior?: unknown; images?: unknown[]; text: string }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  const sent: string[] = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry() {},
    sendUserMessage(content: string) { sent.push(content); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() { throw new Error("not used"); },
    async routeIntent(input) {
      return input.includes("migration")
        ? { status: "ROUTED", workflow: "WAYFIND", source: "jev" }
        : { status: "ROUTED", workflow: "TRIAGE", source: "jev" };
    },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify() {} } };

  assert.deepEqual(
    await inputHandler?.({ source: "user", text: "Triage this incoming bug report" }, context),
    { action: "handled" },
  );
  assert.deepEqual(
    await inputHandler?.({ source: "user", text: "Map a migration with unknown dependencies" }, context),
    { action: "handled" },
  );

  assert.match(sent[0] ?? "", /^\/skill:triage /);
  assert.match(sent[1] ?? "", /^\/skill:wayfinder /);
});

test("explicit local Matt workflows remain available when Jev is missing or misconfigured", async () => {
  const missingJev = configuredIntentRouter({});
  const invalidJev = configuredIntentRouter({ PI_LEAD_JEV_OPENROUTER_KEY: "configured-but-unapproved" });

  assert.deepEqual(await missingJev?.("triage the issue", "TRIAGE"), {
    status: "ROUTED", workflow: "TRIAGE", source: "explicit",
  });
  assert.deepEqual(await invalidJev?.("map the effort", "WAYFIND"), {
    status: "ROUTED", workflow: "WAYFIND", source: "explicit",
  });
  assert.deepEqual(await invalidJev?.("classify this naturally"), {
    status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE",
  });
});

test("the planning command dispatches the installed Matt skill flow without starting a build", async () => {
  let planCommand: { handler: (args: string, context: unknown) => Promise<void> } | undefined;
  const sent: Array<{ content: string; options: unknown }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: typeof planCommand) {
      if (name === "lead-plan") planCommand = definition;
    },
    appendEntry() {},
    sendUserMessage(content: string, options: unknown) { sent.push({ content, options }); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() { throw new Error("not used"); },
    async routeIntent(_input, workflow) {
      assert.equal(workflow, "IDEATE");
      return { status: "ROUTED", workflow: "IDEATE", source: "explicit" };
    },
  })(pi);

  await planCommand?.handler("Plan safer release notes", {
    cwd: "/consumer",
    ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
  });
  assert.match(sent[0]?.content ?? "", /^\/skill:ask-matt /);
  assert.deepEqual(sent[0]?.options, { expandPromptTemplates: true });
  assert.deepEqual(notices, [{ message: "PI Lead plan: sent to Ask Matt; no build was started", level: "info" }]);
});

test("the Lead exposes native Matt triage and wayfinding commands without starting workers", async () => {
  const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
  const sent: Array<{ content: string; options: unknown }> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: (args: string, context: unknown) => Promise<void> }) {
      commands.set(name, definition);
    },
    appendEntry() {},
    sendUserMessage(content: string, options: unknown) { sent.push({ content, options }); },
  } as unknown as ExtensionAPI;
  const routed: string[] = [];
  createLeadExtension({
    async runFixture() { throw new Error("not used"); },
    async routeIntent(_input, workflow) {
      routed.push(workflow ?? "");
      if (workflow === "TRIAGE" || workflow === "WAYFIND") {
        return { status: "ROUTED", workflow, source: "explicit" };
      }
      throw new Error("not reached");
    },
  })(pi);
  const context = {
    cwd: "/consumer",
    ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
  };

  await commands.get("lead-triage")?.handler("#42: investigate export", context);
  await commands.get("lead-wayfind")?.handler("plan a foggy migration", context);

  assert.match(sent[0]?.content ?? "", /^\/skill:triage /);
  assert.match(sent[1]?.content ?? "", /^\/skill:wayfinder /);
  assert.deepEqual(routed, ["TRIAGE", "WAYFIND"]);
  assert.deepEqual(sent.map((message) => message.options), [
    { expandPromptTemplates: true },
    { expandPromptTemplates: true },
  ]);
  assert.deepEqual(notices, [
    { message: "PI Lead triage: sent to Matt; no build was started", level: "info" },
    { message: "PI Lead wayfinding: sent to Matt; no build was started", level: "info" },
  ]);
});
