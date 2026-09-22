import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLeadExtension } from "../src/lead.ts";
import type { ChatGptTaskRequest, ChatGptTaskSummary } from "../src/chatgpt-task.ts";

test("plain chat spawns nothing while explicit admission and the command escape hatch share the read-only path", async () => {
  const commands = new Map<string, (args: string, context: unknown) => Promise<void>>();
  let inputHandler:
    | ((event: {
        text: string;
        source: "interactive" | "rpc" | "extension";
        streamingBehavior?: "steer" | "followUp";
      }, context: unknown) => Promise<{ action: string }>)
    | undefined;
  const requests: ChatGptTaskRequest[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: typeof inputHandler) {
      if (event === "input") inputHandler = handler;
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
    async runChatGpt(request) {
      requests.push(request);
      return {
        status: "DONE",
        taskId: request.taskId,
        assignmentId: request.assignmentId,
        workerId: `worker-${requests.length}`,
        vmId: `vm-${requests.length}`,
        tabId: `tab-${requests.length}`,
        paneId: `pane-${requests.length}`,
        piSessionId: `session-${requests.length}`,
        artifactId: `artifact-${requests.length}`,
        output: `answer ${requests.length}`,
        vmTerminated: true,
      } satisfies ChatGptTaskSummary;
    },
    async routeIntent(_input, workflow) {
      assert.ok(workflow === undefined || workflow === "CHAT");
      return { status: "ROUTED", workflow: "CHAT", source: "explicit" };
    },
  })(pi);
  const cwd = await mkdtemp(join(tmpdir(), "pi-lead-extension-"));
  await writeFile(join(cwd, "CONTEXT.md"), "Lead coordinates workers.\n", "utf8");
  const context = { cwd, ui: { notify() {} } };

  assert.deepEqual(
    await inputHandler?.({ text: "How does PI Lead work?", source: "interactive" }, context),
    { action: "continue" },
  );
  assert.equal(requests.length, 0);

  assert.deepEqual(
    await inputHandler?.(
      { text: "Lead: ask worker which module owns cleanup?", source: "interactive" },
      context,
    ),
    { action: "handled" },
  );
  await commands.get("lead-read")?.("which policy denies WebSockets?", context);
  await commands.get("lead-read")?.("--input CONTEXT.md -- what does Lead do?", context);

  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.question, "which module owns cleanup?");
  assert.equal(requests[1]?.question, "which policy denies WebSockets?");
  assert.match(requests[2]?.question ?? "", /BEGIN PROJECT INPUT: CONTEXT\.md/);
  assert.match(requests[2]?.question ?? "", /Lead coordinates workers\./);
  assert.equal(entries.filter((entry) => entry.type === "pi-lead:chatgpt-summary").length, 3);
});

test("steering and extension-originated text never create a second worker task", async () => {
  let inputHandler: ((event: unknown, context: unknown) => Promise<{ action: string }>) | undefined;
  let runCount = 0;
  const pi = {
    on(event: string, handler: typeof inputHandler) {
      if (event === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() {
      throw new Error("fixture should not run");
    },
    async runChatGpt() {
      runCount++;
      throw new Error("must not run");
    },
  })(pi);
  const context = { cwd: "/consumer", ui: { notify() {} } };

  assert.deepEqual(
    await inputHandler?.(
      { text: "Lead: ask worker follow this up", source: "interactive", streamingBehavior: "followUp" },
      context,
    ),
    { action: "continue" },
  );
  assert.deepEqual(
    await inputHandler?.(
      { text: "Lead: ask worker recursive task", source: "extension" },
      context,
    ),
    { action: "continue" },
  );
  assert.equal(runCount, 0);
});

test("streaming follow-ups stay in the current turn while an ordinary concurrent request gets new admission", async () => {
  let inputHandler: ((event: any, context: any) => Promise<{ action: string }>) | undefined;
  let release: (() => void) | undefined;
  const sent: string[] = [];
  let naturalRoutes = 0;
  const pi = {
    on(event: string, handler: typeof inputHandler) {
      if (event === "input") inputHandler = handler;
      return () => undefined;
    },
    registerCommand() {}, appendEntry() {},
    sendUserMessage(message: string) { sent.push(message); },
  } as unknown as ExtensionAPI;
  createLeadExtension({
    async runFixture() { throw new Error("not used"); },
    async runChatGpt(request) {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        status: "DONE", ...request, workerId: "worker", vmId: "vm", tabId: "tab", paneId: "pane",
        piSessionId: "session", artifactId: "artifact", output: "done", vmTerminated: true,
      };
    },
    async routeIntent(_input, explicit) {
      if (explicit === "CHAT") return { status: "ROUTED", workflow: "CHAT", source: "explicit" };
      naturalRoutes++;
      return { status: "ROUTED", workflow: "IDEATE", source: "jev" };
    },
  })(pi);
  const context = { cwd: process.cwd(), ui: { notify() {} } };

  const active = inputHandler?.({ text: "Lead: ask worker inspect this", source: "interactive" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await inputHandler?.({ text: "more detail", source: "interactive", streamingBehavior: "followUp" }, context), { action: "continue" });
  assert.deepEqual(await inputHandler?.({ text: "plan a separate change", source: "interactive" }, context), { action: "handled" });
  assert.equal(naturalRoutes, 1);
  assert.match(sent[0] ?? "", /^\/skill:ask-matt /);
  release?.();
  await active;
});
