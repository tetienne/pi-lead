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
    async routeIntent(_input, workflow) {
      assert.equal(workflow, "CHAT");
      return { status: "ROUTED", workflow: "CHAT", source: "explicit" };
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
    async routeIntent(_input, workflow) {
      assert.equal(workflow, "CHAT");
      return { status: "ROUTED", workflow: "CHAT", source: "explicit" };
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
    async runFixture() { throw new Error("not used"); },
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
  createLeadExtension({ async runFixture() { throw new Error("not used"); }, routeIntent: configuredIntentRouter({}) })(pi);

  await command?.("debug and implement this crash", {
    cwd: "/consumer",
    ui: { notify(message: string) { notices.push(message); } },
  });
  assert.deepEqual(notices, ["PI Lead intent: clarification required; no worker was started"]);
});

test("/lead submits the unchanged natural-language request to Jev before considering outage fallback", async () => {
  let command: ((args: string, context: any) => Promise<void>) | undefined;
  const routed: Array<{ input: string; explicit: unknown }> = [];
  const pi = {
    on() { return () => undefined; },
    registerCommand(name: string, definition: { handler: typeof command }) {
      if (name === "lead") command = definition.handler;
    },
    appendEntry() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() { throw new Error("not used"); },
    async routeIntent(input, explicit) {
      routed.push({ input, explicit });
      return { status: "ROUTED", workflow: "CHAT", source: "jev" };
    },
  })(pi);

  await command?.("Could you untangle this for me?", { cwd: "/consumer", ui: { notify() {} } });
  assert.deepEqual(routed, [{ input: "Could you untangle this for me?", explicit: undefined }]);
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
    async runFixture() { throw new Error("not used"); },
    routeIntent: configuredIntentRouter({}),
    async runCompleteLocalCoding() { throw new Error("incomplete intake must not start a worker"); },
  })(pi);
  const context = { cwd: process.cwd(), ui: { notify(message: string) { notices.push(message); } } };

  assert.deepEqual(await inputHandler?.({ source: "user", text: "implement the approved change" }, context), { action: "handled" });
  assert.match(notices[0] ?? "", /which approved specification, named base, and mise checks/);
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
    async runFixture() { throw new Error("not used"); },
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
    async runFixture() { throw new Error("not used"); },
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
    async runFixture() { throw new Error("not used"); },
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
    async runFixture() { throw new Error("not used"); },
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
    async runFixture() { throw new Error("not used"); },
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
