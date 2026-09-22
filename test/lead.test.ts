import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredIntentRouter, createLeadExtension } from "../src/lead.ts";

test("the installed Lead exposes only the unified /lead command", () => {
  const commands: string[] = [];
  const pi = {
    on() {
      return () => undefined;
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;

  createLeadExtension({
    async routeIntent() {
      return { status: "ROUTED", workflow: "CHAT", source: "jev" };
    },
  })(pi);

  assert.deepEqual(commands, ["lead"]);
});

test("historical Lead text forms receive no provider or workflow special handling", async () => {
  let inputHandler:
    | ((event: { source: string; text: string }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  const routed: string[] = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async routeIntent(input) {
      routed.push(input);
      return { status: "ROUTED", workflow: "CHAT", source: "jev" };
    },
  })(pi);

  const context = { cwd: "/consumer", ui: { notify() {} } };
  assert.deepEqual(
    await inputHandler?.({ source: "interactive", text: "Lead: ask worker inspect this" }, context),
    { action: "continue" },
  );
  assert.deepEqual(
    await inputHandler?.({ source: "interactive", text: "Lead: implement inspect this" }, context),
    { action: "continue" },
  );
  assert.deepEqual(routed, [
    "Lead: ask worker inspect this",
    "Lead: implement inspect this",
  ]);
});

test("steering, follow-ups, images and extension messages bypass task admission", async () => {
  let inputHandler: ((event: any, context: unknown) => Promise<{ action: string }>) | undefined;
  let routes = 0;
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async routeIntent() {
      routes++;
      return { status: "ROUTED", workflow: "CHAT", source: "jev" };
    },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify() {} } };

  for (const event of [
    { source: "interactive", text: "more detail", streamingBehavior: "followUp" },
    { source: "interactive", text: "urgent correction", streamingBehavior: "steer" },
    { source: "interactive", text: "describe this", images: [{}] },
    { source: "extension", text: "recursive request" },
  ]) {
    assert.deepEqual(await inputHandler?.(event, context), { action: "continue" });
  }
  assert.equal(routes, 0);
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

test("Jev availability does not create workflow-specific request vocabulary", async () => {
  const missingJev = configuredIntentRouter({});
  const invalidJev = configuredIntentRouter({ PI_LEAD_JEV_OPENROUTER_KEY: "configured-but-unapproved" });

  assert.deepEqual(await missingJev?.("triage the issue"), {
    status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE",
  });
  assert.deepEqual(await invalidJev?.("map the effort"), {
    status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE",
  });
});

test("/lead uses the same orchestrator and explicit fallback when Jev is unavailable", async () => {
  let command: ((args: string, context: any) => Promise<void>) | undefined;
  const sent: string[] = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: typeof command }) {
      if (name === "lead") command = definition.handler;
    },
    appendEntry() {},
    sendUserMessage(message: string) { sent.push(message); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    routeIntent: configuredIntentRouter({}),
  })(pi);

  await command?.("triage the startup report", { cwd: "/consumer", ui: { notify() {} } });
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /^\/skill:triage /);
  assert.match(sent[0] ?? "", /triage the startup report/);
});

test("/lead asks for clarification when its deterministic fallback matches multiple workflows", async () => {
  let command: ((args: string, context: any) => Promise<void>) | undefined;
  const notices: string[] = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: typeof command }) {
      if (name === "lead") command = definition.handler;
    },
    appendEntry() {},
    sendUserMessage() { throw new Error("ambiguous input must not be dispatched"); },
  } as unknown as ExtensionAPI;
  createLeadExtension({ routeIntent: configuredIntentRouter({}) })(pi);

  await command?.("debug and implement this crash", {
    cwd: "/consumer",
    ui: { notify(message: string) { notices.push(message); } },
  });
  assert.deepEqual(notices, ["PI Lead intent: clarification required; no worker was started"]);
});

test("/lead submits the unchanged natural-language request to Jev before considering outage fallback", async () => {
  let command: ((args: string, context: any) => Promise<void>) | undefined;
  const routed: string[] = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: typeof command }) {
      if (name === "lead") command = definition.handler;
    },
    appendEntry() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async routeIntent(input) {
      routed.push(input);
      return { status: "ROUTED", workflow: "CHAT", source: "jev" };
    },
  })(pi);

  await command?.("Could you untangle this for me?", { cwd: "/consumer", ui: { notify() {} } });
  assert.deepEqual(routed, ["Could you untangle this for me?"]);
});

test("ordinary engineering intent fails closed through deterministic admission when Jev is unavailable", async () => {
  let inputHandler: ((event: { source: string; text: string }, context: any) => Promise<{ action: string }>) | undefined;
  const notices: string[] = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {}, appendEntry() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    routeIntent: configuredIntentRouter({}),
    async runCompleteLocalCoding() { throw new Error("incomplete intake must not start a worker"); },
  })(pi);
  const context = { cwd: process.cwd(), ui: { notify(message: string) { notices.push(message); } } };

  assert.deepEqual(await inputHandler?.({ source: "user", text: "implement the approved change" }, context), { action: "handled" });
  assert.match(notices[0] ?? "", /which approved specification, named base, and mise checks/);
});

test("structured debug and review requests remain usable when Jev is unavailable", async () => {
  let inputHandler:
    | ((event: { source: string; text: string }, context: any) => Promise<{ action: string }>)
    | undefined;
  const executed: string[] = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {}, appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    routeIntent: configuredIntentRouter({}),
    async runDebug(request) {
      executed.push(`debug:${request.feedbackCommand}`);
      return {
        status: "BLOCKED",
        reason: "REPRODUCTION_NOT_FAILED",
        detail: "controlled feedback passed",
        diagnosticsRetained: true,
      };
    },
    async runReview(request) {
      executed.push(`review:${request.namedBase}..${request.reviewBranch}`);
      return {
        status: "DONE",
        taskId: request.taskId,
        comparisonSource: "git:HEAD..HEAD",
        reports: [],
        specification: { status: "MISSING_SPECIFICATION" },
        readOnly: true,
        published: false,
      };
    },
  })(pi);
  const context = { cwd: process.cwd(), ui: { notify() {} } };

  assert.deepEqual(await inputHandler?.({
    source: "user",
    text: "--base HEAD --check test --spec .scratch/pi-lead/issues/20-refocused-product-acceptance.md -- reproduce this crash",
  }, context), { action: "handled" });
  assert.deepEqual(await inputHandler?.({
    source: "user",
    text: "--base HEAD --branch HEAD",
  }, context), { action: "handled" });

  assert.deepEqual(executed, ["debug:mise run test", "review:HEAD..HEAD"]);
});

test("ordinary input and /lead admit every supported Matt workflow through one orchestrator", async () => {
  const commands = new Map<string, (args: string, context: unknown) => Promise<void>>();
  let inputHandler:
    | ((event: { source: string; text: string }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  let messageEnd: ((event: any, context: unknown) => void) | undefined;
  let agentSettled: ((event: any, context: unknown) => void) | undefined;
  const sent: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const workflows = ["CHAT", "IMPLEMENT", "IDEATE", "DEBUG", "REVIEW", "RESEARCH", "TRIAGE", "WAYFIND", "OPERATE"] as const;
  const pi = {
    on(name: string, handler: any) {
      if (name === "input") inputHandler = handler;
      if (name === "message_end") messageEnd = handler;
      if (name === "agent_settled") agentSettled = handler;
      return () => undefined;
    },
    registerCommand(name: string, definition: { handler: (args: string, context: unknown) => Promise<void> }) {
      commands.set(name, definition.handler);
    },
    sendUserMessage(message: string) { sent.push(message); },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  let index = 0;
  createLeadExtension({
    async routeIntent() {
      const workflow = workflows[index++];
      if (!workflow) throw new Error("unexpected route");
      return { status: "ROUTED", workflow, source: "jev" };
    },
  })(pi);
  const context = {
    cwd: "/consumer",
    ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
  };

  assert.ok(commands.has("lead"));
  assert.deepEqual(await inputHandler?.({ source: "user", text: "chat" }, context), { action: "continue" });
  for (const request of ["implement", "ideate", "debug", "review", "research", "triage", "wayfind"]) {
    assert.deepEqual(await inputHandler?.({ source: "user", text: request }, context), { action: "handled" });
    if (request === "debug" || request === "review" || request === "research") {
      messageEnd?.({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, context);
      agentSettled?.({}, context);
    }
  }
  await commands.get("lead")?.("operate", context);

  assert.deepEqual(sent.map((message) => message.match(/^\/skill:[^ ]+/)?.[0]), [
    "/skill:ask-matt", "/skill:triage", "/skill:wayfinder",
  ]);
  assert.deepEqual(notices.at(-1), {
    message: "PI Lead operation: human authorization required; no worker was started",
    level: "info",
  });
  assert.deepEqual(notices[0], {
    message: "PI Lead implement: unavailable; no worker was started",
    level: "error",
  });
});

test("a natural implementation request asks conversationally for its approved validation context", async () => {
  let inputHandler:
    | ((event: { source: string; text: string }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  const notices: Array<{ message: string; level: string }> = [];
  const pi = {
    on(name: string, handler: typeof inputHandler) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runCompleteLocalCoding() { throw new Error("not reached"); },
    async routeIntent() { return { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" }; },
  })(pi);

  assert.deepEqual(
    await inputHandler?.(
      { source: "user", text: "Implement a new welcome screen" },
      { cwd: process.cwd(), ui: { notify(message: string, level: string) { notices.push({ message, level }); } } },
    ),
    { action: "handled" },
  );
  assert.deepEqual(notices, [{
    message: "PI Lead implement: clarification required — which approved specification, named base, and mise checks should govern this change?",
    level: "info",
  }]);
});

test("Lead restart admits host-owned recovery before any new engineering task", async () => {
  let sessionStart: ((event: { reason: string }, context: any) => Promise<void>) | undefined;
  let inputHandler: ((event: { source: string; text: string }, context: any) => Promise<{ action: string }>) | undefined;
  let implementationRuns = 0;
  const entries: Array<{ type: string; data: unknown }> = [];
  const notices: string[] = [];
  const pi = {
    on(name: string, handler: any) {
      if (name === "session_start") sessionStart = handler;
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runCompleteLocalCoding() { implementationRuns++; throw new Error("must not run"); },
    async recoverInterrupted() {
      return [{ taskId: "task-interrupted", reason: "RESUME_CONFIRMATION_REQUIRED", resumeAllowed: true }];
    },
    async routeIntent(input) {
      return input === "hello"
        ? { status: "ROUTED", workflow: "CHAT", source: "jev" }
        : { status: "ROUTED", workflow: "IMPLEMENT", source: "jev" };
    },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify(message: string) { notices.push(message); } } };

  await sessionStart?.({ reason: "startup" }, context);
  assert.deepEqual(await inputHandler?.({ source: "user", text: "hello" }, context), { action: "continue" });
  assert.deepEqual(await inputHandler?.({ source: "user", text: "implement it" }, context), { action: "handled" });

  assert.equal(implementationRuns, 0);
  assert.equal(entries[0]?.type, "pi-lead:recovery-summary");
  assert.match(notices.join("\n"), /task-interrupted.*confirmation required/i);
});

test("an interrupted task is admitted again only after explicit recovery confirmation", async () => {
  let sessionStart: ((event: unknown, context: any) => Promise<void>) | undefined;
  let inputHandler: ((event: { source: string; text: string }, context: any) => Promise<{ action: string }>) | undefined;
  const confirmed: string[] = [];
  const notices: string[] = [];
  const pi = {
    on(name: string, handler: any) {
      if (name === "session_start") sessionStart = handler;
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {}, appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async recoverInterrupted() { return [{ taskId: "task-resume", reason: "RESUME_CONFIRMATION_REQUIRED", resumeAllowed: true }]; },
    async confirmRecovery(_cwd, taskId) { confirmed.push(taskId); },
    async routeIntent() { return { status: "ROUTED", workflow: "IDEATE", source: "jev" }; },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify(message: string) { notices.push(message); } } };
  await sessionStart?.({}, context);

  assert.deepEqual(await inputHandler?.({ source: "user", text: "resume interrupted task task-resume" }, context), { action: "handled" });
  assert.deepEqual(confirmed, ["task-resume"]);
  assert.match(notices.at(-1) ?? "", /resubmit the request/i);
});

test("native debug, review, and Matt research use attributable worker lifecycles", async () => {
  let inputHandler: ((event: { source: string; text: string }, context: any) => Promise<{ action: string }>) | undefined;
  const entries: Array<{ type: string; data: any }> = [];
  const notices: string[] = [];
  const executed: string[] = [];
  const pi = {
    on(name: string, handler: any) {
      if (name === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const workflows = ["DEBUG", "REVIEW", "RESEARCH"] as const;
  let route = 0;
  createLeadExtension({
    async runDebug(request) {
      executed.push(`debug:${request.feedbackCommand}`);
      return { status: "BLOCKED", reason: "REPRODUCTION_NOT_FAILED", detail: "controlled feedback passed", diagnosticsRetained: true };
    },
    async runReview(request) {
      executed.push(`review:${request.namedBase}..${request.reviewBranch}`);
      return {
        status: "DONE", taskId: request.taskId, comparisonSource: "git:base..review",
        reports: [{
          taskId: request.taskId, axis: "STANDARDS", reviewerId: "reviewer", contextId: "context",
          comparisonSource: "git:base..review", standardsDigest: request.standards.digest,
          findings: [], readOnly: true, published: false,
        }],
        specification: { status: "MISSING_SPECIFICATION" }, readOnly: true, published: false,
      };
    },
    async runResearch(request) {
      executed.push(`research:${request.assignmentId}`);
      assert.match(request.instruction, /pinned Matt research skill/);
      assert.deepEqual(request.dependencyHosts, ["example.com"]);
      return {
        status: "REVIEW_REQUIRED", taskId: request.taskId, assignmentId: request.assignmentId,
        workerId: "researcher", vmId: "research-vm", tabId: "research-tab", paneId: "research-pane",
        piSessionId: "research-session", artifactId: "research-artifact",
        baseCommit: "a".repeat(40), proposedCommit: "b".repeat(40),
        validations: [{ task: "test", command: "mise run test", passed: true, exitCode: 0 }],
        files: [{ path: "docs/research/note.md", status: "added", oldMode: "000000", newMode: "100644", contentBase64: Buffer.from("[source](https://example.com)").toString("base64"), binary: false }],
        humanGate: true, hostCommitted: false, published: false, vmTerminated: true,
      };
    },
    async routeIntent() {
      return { status: "ROUTED", workflow: workflows[route++] ?? "CHAT", source: "jev" };
    },
  })(pi);
  const context = { cwd: process.cwd(), ui: { notify(message: string) { notices.push(message); } } };

  assert.deepEqual(await inputHandler?.({ source: "user", text: "--base HEAD --check test --spec .scratch/pi-lead/issues/18-unified-orchestration.md -- reproduce it" }, context), { action: "handled" });
  assert.deepEqual(await inputHandler?.({ source: "user", text: "--base HEAD --branch HEAD" }, context), { action: "handled" });
  assert.deepEqual(await inputHandler?.({ source: "user", text: "--base HEAD --check test --allow example.com -- research this" }, context), { action: "handled" });

  assert.deepEqual(executed.slice(0, 2), ["debug:mise run test", "review:HEAD..HEAD"]);
  assert.match(executed[2] ?? "", /^research:/);
  assert.deepEqual(entries.map((entry) => entry.type), [
    "pi-lead:debug-task-summary", "pi-lead:standalone-review-summary", "pi-lead:research-summary",
  ]);
  assert.equal(notices.filter((notice) => /DONE/.test(notice)).length, 1);
  assert.match(notices.at(-1) ?? "", /REVIEW_REQUIRED/);
});
