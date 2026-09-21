import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_ACTIVE_WORKERS } from "./policy.ts";
import { prepareChatGptQuestion } from "./chatgpt-input.ts";
import {
  runReadOnlyChatGptTask,
  type ChatGptRunSummary,
  type ChatGptTaskRequest,
  type UnstartedChatGptBlockedSummary,
} from "./chatgpt-task.ts";
import {
  runIsolatedFixture,
  type FixtureRequest,
  type FixtureRunSummary,
  type UnstartedFixtureSummary,
} from "./task-lifecycle.ts";

type LeadDependencies = {
  runFixture(
    request: FixtureRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<FixtureRunSummary>;
  runChatGpt?(
    request: ChatGptTaskRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ChatGptRunSummary>;
};

export function createLeadExtension(dependencies: LeadDependencies) {
  return (pi: ExtensionAPI): void => {
    const activeRuns = new Set<AbortController>();

    const runChatGpt = async (
      question: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ): Promise<void> => {
      if (!dependencies.runChatGpt) return;
      let preparedQuestion: string;
      try {
        preparedQuestion = await prepareChatGptQuestion(question, context.cwd);
      } catch (error) {
        context.ui.notify(
          `PI Lead worker: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      const request = { taskId: randomUUID(), assignmentId: randomUUID(), question: preparedQuestion };
      let summary: ChatGptRunSummary;
      if (activeRuns.size >= MAX_ACTIVE_WORKERS) {
        summary = {
          status: "BLOCKED",
          reason: "CONCURRENCY_LIMIT",
          detail: `At most ${MAX_ACTIVE_WORKERS} workers may be active`,
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          diagnosticsRetained: false,
          resourcesStarted: false,
          vmTerminated: true,
        } satisfies UnstartedChatGptBlockedSummary;
      } else {
        const controller = new AbortController();
        activeRuns.add(controller);
        try {
          summary = await dependencies.runChatGpt(request, context.cwd, controller.signal);
        } catch (error) {
          summary = {
            status: "BLOCKED",
            reason: "NATIVE_CONTROL_UNAVAILABLE",
            detail: error instanceof Error ? error.message : String(error),
            taskId: request.taskId,
            assignmentId: request.assignmentId,
            diagnosticsRetained: false,
            resourcesStarted: false,
            vmTerminated: false,
          } satisfies UnstartedChatGptBlockedSummary;
        } finally {
          activeRuns.delete(controller);
        }
      }
      pi.appendEntry("pi-lead:chatgpt-summary", summary);
      const detail = summary.status === "DONE" ? summary.output : summary.detail ?? summary.reason;
      context.ui.notify(
        `PI Lead worker: ${summary.status} — ${detail}`,
        summary.status === "DONE" ? "info" : "error",
      );
    };

    pi.on("session_shutdown", async () => {
      for (const controller of activeRuns) {
        controller.abort(new DOMException("Lead session closed", "AbortError"));
      }
    });

    if (dependencies.runChatGpt) {
      pi.on("input", async (event, context) => {
        if (event.source === "extension" || event.streamingBehavior !== undefined || event.images?.length) {
          return { action: "continue" };
        }
        const match = /^lead:\s*ask worker\s+(.+)$/is.exec(event.text);
        if (!match?.[1]) return { action: "continue" };
        await runChatGpt(match[1], context);
        return { action: "handled" };
      });

      pi.registerCommand("lead-read", {
        description: "Ask an isolated ChatGPT worker a bounded read-only question",
        handler: async (args, context) => runChatGpt(args, context),
      });
    }

    pi.registerCommand("lead-fixture", {
      description: "Run the PI Lead isolated fixture",
      handler: async (_args, context) => {
        const request = { taskId: randomUUID(), assignmentId: randomUUID() };
        let summary: FixtureRunSummary;
        if (activeRuns.size >= MAX_ACTIVE_WORKERS) {
          summary = {
            status: "BLOCKED",
            reason: "CONCURRENCY_LIMIT",
            detail: `At most ${MAX_ACTIVE_WORKERS} workers may be active`,
            ...request,
            diagnosticsRetained: false,
            resourcesStarted: false,
            vmTerminated: true,
          } satisfies UnstartedFixtureSummary;
          pi.appendEntry("pi-lead:fixture-summary", summary);
          context.ui.notify(`PI Lead fixture: BLOCKED — ${summary.reason}`, "error");
          return;
        }
        const controller = new AbortController();
        activeRuns.add(controller);
        try {
          try {
            summary = await dependencies.runFixture(request, context.cwd, controller.signal);
          } catch (error) {
            summary = {
              status: "BLOCKED",
              reason: "NATIVE_CONTROL_UNAVAILABLE",
              detail: error instanceof Error ? error.message : String(error),
              ...request,
              diagnosticsRetained: false,
              resourcesStarted: false,
              vmTerminated: false,
            } satisfies UnstartedFixtureSummary;
          }
          pi.appendEntry("pi-lead:fixture-summary", summary);
          const detail = summary.status === "DONE" ? summary.output : summary.reason;
          context.ui.notify(
            `PI Lead fixture: ${summary.status} — ${detail}`,
            summary.status === "DONE" ? "info" : "error",
          );
        } finally {
          activeRuns.delete(controller);
        }
      },
    });
  };
}

export default createLeadExtension({
  async runFixture(request, cwd, signal) {
    const { createNativeFixtureRuntime } = await import("./native-runtime.ts");
    const runtime = await createNativeFixtureRuntime({ cwd });
    return runIsolatedFixture(request, runtime, { signal });
  },
  async runChatGpt(request, cwd, signal) {
    const { createNativeChatGptRuntime } = await import("./native-chatgpt-runtime.ts");
    const runtime = await createNativeChatGptRuntime({ cwd });
    return runReadOnlyChatGptTask(request, runtime, { signal });
  },
});
