import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_ACTIVE_WORKERS } from "./policy.ts";
import { createJevIntentRouter, JEV_WORKFLOWS, type JevRoutingOutcome, type JevWorkflow } from "./jev-intent-routing.ts";
import { createOpenRouterJevTransport } from "./openrouter-jev-transport.ts";
import { prepareChatGptQuestion } from "./chatgpt-input.ts";
import { parseProposedChangeInput } from "./proposed-change-input.ts";
import { pinReviewSpecification, pinReviewStandards } from "./review-context.ts";
import {
  runProposedChangeTask,
  type ProposedChangeRequest,
  type ProposedChangeSummary,
  type UnstartedProposedChangeSummary,
} from "./proposed-change-task.ts";
import {
  runReviewFixCommitTask,
  type CompleteLocalCodingRequest,
  type CompleteLocalCodingSummary,
} from "./review-fix-commit-task.ts";
import {
  runReadOnlyChatGptTask,
  type ChatGptRunSummary,
  type ChatGptTaskRequest,
  type UnstartedChatGptBlockedSummary,
} from "./chatgpt-task.ts";
import {
  runReadOnlyOpenCodeGoTask,
  type OpenCodeGoRunSummary,
  type OpenCodeGoTaskRequest,
} from "./opencode-go-task.ts";
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
  runOpenCodeGo?(
    request: OpenCodeGoTaskRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<OpenCodeGoRunSummary>;
  runProposedChange?(
    request: ProposedChangeRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ProposedChangeSummary>;
  runCompleteLocalCoding?(
    request: CompleteLocalCodingRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<CompleteLocalCodingSummary>;
  routeIntent?(input: string, explicitWorkflow?: JevWorkflow): Promise<JevRoutingOutcome>;
};

function configuredIntentRouter(): LeadDependencies["routeIntent"] | undefined {
  const apiKey = process.env.PI_LEAD_JEV_OPENROUTER_KEY;
  if (!apiKey) {
    return async (_input, explicitWorkflow) => {
      if (!explicitWorkflow) return { status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" };
      return explicitWorkflow === "CHAT"
        ? { status: "ROUTED", workflow: "CHAT", source: "explicit" }
        : { status: "UNAVAILABLE", workflow: explicitWorkflow, reason: "WORKFLOW_UNAVAILABLE" };
    };
  }
  const resetHourUtc = Number(process.env.PI_LEAD_JEV_RESET_HOUR_UTC);
  if (
    process.env.PI_LEAD_JEV_DEDICATED_KEY_CONFIRMED !== "yes" ||
    process.env.PI_LEAD_JEV_PROVIDER_DAILY_CAP_USD !== "1" ||
    !Number.isInteger(resetHourUtc) || resetHourUtc < 0 || resetHourUtc > 23
  ) {
    return async () => ({ status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" });
  }
  const router = createJevIntentRouter({
    transport: createOpenRouterJevTransport({ apiKey }),
    getState: () => ({ version: 1, availability: { CHAT: true } }),
    budget: { dailyCapUsd: 1, reservationUsd: 0.01, resetHourUtc },
  });
  return router.route;
}

export function createLeadExtension(dependencies: LeadDependencies) {
  return (pi: ExtensionAPI): void => {
    const activeRuns = new Map<AbortController, number>();
    const queuedRuns: Array<{
      slots: number;
      controller: AbortController;
      resolve(controller: AbortController): void;
      reject(reason: unknown): void;
    }> = [];
    let shuttingDown = false;
    const activeWorkerSlots = () => [...activeRuns.values()].reduce((sum, slots) => sum + slots, 0);
    const startQueuedRuns = () => {
      while (true) {
        const index = queuedRuns.findIndex((queued) =>
          activeWorkerSlots() + queued.slots <= MAX_ACTIVE_WORKERS,
        );
        if (index < 0) return;
        const queued = queuedRuns.splice(index, 1)[0];
        if (!queued) return;
        activeRuns.set(queued.controller, queued.slots);
        queued.resolve(queued.controller);
      }
    };
    const reserveWorkerSlots = (slots: number): Promise<AbortController> => {
      const controller = new AbortController();
      if (shuttingDown) {
        controller.abort(new DOMException("Lead session closed", "AbortError"));
        return Promise.reject(controller.signal.reason);
      }
      if (activeWorkerSlots() + slots <= MAX_ACTIVE_WORKERS) {
        activeRuns.set(controller, slots);
        return Promise.resolve(controller);
      }
      return new Promise((resolvePromise, reject) => {
        queuedRuns.push({ slots, controller, resolve: resolvePromise, reject });
      });
    };
    const releaseWorkerSlots = (controller: AbortController) => {
      activeRuns.delete(controller);
      startQueuedRuns();
    };

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
      if (activeWorkerSlots() + 1 > MAX_ACTIVE_WORKERS) {
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
        activeRuns.set(controller, 1);
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
          releaseWorkerSlots(controller);
        }
      }
      pi.appendEntry("pi-lead:chatgpt-summary", summary);
      const detail = summary.status === "DONE" ? summary.output : summary.detail ?? summary.reason;
      context.ui.notify(
        `PI Lead worker: ${summary.status} — ${detail}`,
        summary.status === "DONE" ? "info" : "error",
      );
    };

    const runOpenCodeGo = async (
      question: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ): Promise<void> => {
      if (!dependencies.runOpenCodeGo) return;
      let preparedQuestion: string;
      try { preparedQuestion = await prepareChatGptQuestion(question, context.cwd); }
      catch (error) {
        context.ui.notify(`PI Lead OpenCode Go worker: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const request = { taskId: randomUUID(), assignmentId: randomUUID(), question: preparedQuestion };
      let summary: OpenCodeGoRunSummary;
      if (activeWorkerSlots() + 1 > MAX_ACTIVE_WORKERS) {
        summary = { status: "BLOCKED", reason: "CONCURRENCY_LIMIT", detail: `At most ${MAX_ACTIVE_WORKERS} workers may be active`, taskId: request.taskId, assignmentId: request.assignmentId, diagnosticsRetained: false, resourcesStarted: false, vmTerminated: true } satisfies UnstartedChatGptBlockedSummary;
      } else {
        const controller = new AbortController(); activeRuns.set(controller, 1);
        try { summary = await dependencies.runOpenCodeGo(request, context.cwd, controller.signal); }
        catch (error) {
          summary = { status: "BLOCKED", reason: "NATIVE_CONTROL_UNAVAILABLE", detail: error instanceof Error ? error.message : String(error), taskId: request.taskId, assignmentId: request.assignmentId, diagnosticsRetained: false, resourcesStarted: false, vmTerminated: false } satisfies UnstartedChatGptBlockedSummary;
        } finally { releaseWorkerSlots(controller); }
      }
      pi.appendEntry("pi-lead:opencode-go-summary", summary);
      context.ui.notify(`PI Lead OpenCode Go worker: ${summary.status} — ${summary.status === "DONE" ? summary.output : summary.detail ?? summary.reason}`, summary.status === "DONE" ? "info" : "error");
    };

    pi.on("session_shutdown", async () => {
      shuttingDown = true;
      for (const controller of activeRuns.keys()) {
        controller.abort(new DOMException("Lead session closed", "AbortError"));
      }
      for (const queued of queuedRuns.splice(0)) {
        const reason = new DOMException("Lead session closed before queued work started", "AbortError");
        queued.controller.abort(reason);
        queued.reject(reason);
      }
    });

    if (dependencies.runChatGpt || dependencies.routeIntent) {
      pi.on("input", async (event, context) => {
        if (event.source === "extension" || event.streamingBehavior !== undefined || event.images?.length) {
          return { action: "continue" };
        }
        const match = /^lead:\s*ask worker\s+(.+)$/is.exec(event.text);
        if (match?.[1] && dependencies.runChatGpt) {
          await runChatGpt(match[1], context);
          return { action: "handled" };
        }
        const explicit = /^lead:\s*(?:workflow\s+)?([a-z]+)(?:\s+(.+))?$/i.exec(event.text);
        const explicitWorkflow = JEV_WORKFLOWS.find(
          (workflow) => workflow === explicit?.[1]?.toUpperCase(),
        );
        if (!dependencies.routeIntent) return { action: "continue" };
        let outcome: JevRoutingOutcome;
        try {
          outcome = await dependencies.routeIntent(
            explicitWorkflow ? explicit?.[2] ?? event.text : event.text,
            explicitWorkflow,
          );
        } catch {
          context.ui.notify("PI Lead intent: routing unavailable; no worker was started", "error");
          return { action: "handled" };
        }
        if (outcome.status === "ROUTED" && outcome.workflow === "CHAT") {
          return { action: "continue" };
        }
        if (outcome.status === "SERVICE_UNAVAILABLE" && !explicitWorkflow) {
          return { action: "continue" };
        }
        if (outcome.status === "CLARIFICATION_REQUIRED") {
          context.ui.notify("PI Lead intent: clarification required; no worker was started", "info");
          return { action: "handled" };
        }
        if (outcome.status === "UNAVAILABLE") {
          context.ui.notify(`PI Lead intent: ${outcome.workflow} is unavailable; no worker was started`, "info");
          return { action: "handled" };
        }
        if (outcome.status === "ROUTED") {
          context.ui.notify(`PI Lead intent: ${outcome.workflow} requires its workflow entry point; no worker was started`, "info");
          return { action: "handled" };
        }
        context.ui.notify("PI Lead intent: routing unavailable; no worker was started", "error");
        return { action: "handled" };
      });

      pi.registerCommand("lead-read", {
        description: "Ask an isolated ChatGPT worker a bounded read-only question",
        handler: async (args, context) => runChatGpt(args, context),
      });
    }

    if (dependencies.runOpenCodeGo) {
      pi.registerCommand("lead-read-go", {
        description: "Ask an isolated OpenCode Go worker a bounded read-only question",
        handler: async (args, context) => runOpenCodeGo(args, context),
      });
    }

    if (dependencies.runProposedChange) {
      const runProposedChange = dependencies.runProposedChange;
      pi.registerCommand("lead-change", {
        description: "Ask an isolated worker for a validated change requiring human review",
        handler: async (args, context) => {
          let parsed: ReturnType<typeof parseProposedChangeInput>;
          try {
            parsed = parseProposedChangeInput(args);
          } catch (error) {
            context.ui.notify(
              `PI Lead change: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          const request: ProposedChangeRequest = {
            taskId: randomUUID(),
            assignmentId: randomUUID(),
            repositoryPath: context.cwd,
            ...parsed,
          };
          let summary: ProposedChangeSummary;
          if (activeWorkerSlots() + 1 > MAX_ACTIVE_WORKERS) {
            summary = {
              status: "BLOCKED",
              reason: "CONCURRENCY_LIMIT",
              detail: `At most ${MAX_ACTIVE_WORKERS} workers may be active`,
              taskId: request.taskId,
              assignmentId: request.assignmentId,
              diagnosticsRetained: false,
              resourcesStarted: false,
              vmTerminated: true,
            } satisfies UnstartedProposedChangeSummary;
          } else {
            const controller = new AbortController();
            activeRuns.set(controller, 1);
            try {
              summary = await runProposedChange(
                request,
                context.cwd,
                controller.signal,
              );
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
              } satisfies UnstartedProposedChangeSummary;
            } finally {
            releaseWorkerSlots(controller);
            }
          }
          pi.appendEntry("pi-lead:proposed-change-summary", summary);
          const detail =
            summary.status === "REVIEW_REQUIRED"
              ? `${summary.files.length} file(s), validated; human review required`
              : summary.detail ?? summary.reason;
          context.ui.notify(
            `PI Lead change: ${summary.status} — ${detail}`,
            summary.status === "REVIEW_REQUIRED" ? "info" : "error",
          );
        },
      });
    }

    if (dependencies.runCompleteLocalCoding) {
      const runCompleteLocalCoding = dependencies.runCompleteLocalCoding;
      pi.registerCommand("lead-implement", {
        description: "Build, independently review, correct and commit an isolated coding task",
        handler: async (args, context) => {
          let parsed: ReturnType<typeof parseProposedChangeInput>;
          try {
            parsed = parseProposedChangeInput(args);
          } catch (error) {
            context.ui.notify(
              `PI Lead implement: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          let specification: CompleteLocalCodingRequest["specification"];
          let standards: CompleteLocalCodingRequest["standards"];
          try {
            if (!parsed.specSource) throw new Error("implement request requires --spec <relative-markdown-path>");
            [specification, standards] = await Promise.all([
              pinReviewSpecification(context.cwd, parsed.specSource),
              pinReviewStandards(context.cwd),
            ]);
          } catch (error) {
            context.ui.notify(
              `PI Lead implement: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          const request: CompleteLocalCodingRequest = {
            taskId: randomUUID(),
            repositoryPath: context.cwd,
            ...parsed,
            specification,
            standards,
          };
          let summary: CompleteLocalCodingSummary;
          // This task can have its Standards and Spec reviewers active together, so it
          // reserves both permitted worker slots for the whole lifecycle and queues
          // behind already-running work instead of overcommitting reviewer capacity.
          if (activeWorkerSlots() + 2 > MAX_ACTIVE_WORKERS) {
            context.ui.notify("PI Lead implement: QUEUED — waiting for two review slots", "info");
          }
          let controller: AbortController;
          try {
            controller = await reserveWorkerSlots(2);
          } catch (error) {
            summary = {
              status: "BLOCKED",
              taskId: request.taskId,
              reason: "BUILD_BLOCKED",
              detail: error instanceof Error ? error.message : String(error),
              reviews: [],
              reviewHistory: [],
              reviewCycles: 0,
              diagnosticsRetained: true,
              specification,
              standards,
            };
            pi.appendEntry("pi-lead:complete-task-summary", summary);
            context.ui.notify(`PI Lead implement: BLOCKED — ${error instanceof Error ? error.message : String(error)}`, "error");
            return;
          }
          try {
            summary = await runCompleteLocalCoding(request, context.cwd, controller.signal);
          } catch (error) {
            summary = {
              status: "BLOCKED",
              taskId: request.taskId,
              reason: "BUILD_BLOCKED",
              detail: error instanceof Error ? error.message : String(error),
              reviews: [],
              reviewHistory: [],
              reviewCycles: 0,
              diagnosticsRetained: true,
              specification,
              standards,
            };
          } finally {
            releaseWorkerSlots(controller);
          }
          pi.appendEntry("pi-lead:complete-task-summary", summary);
          const detail =
            summary.status === "DONE"
              ? `committed ${summary.commit.commit} on ${summary.commit.branchName}`
              : summary.detail;
          context.ui.notify(
            `PI Lead implement: ${summary.status} — ${detail}`,
            summary.status === "DONE" ? "info" : "error",
          );
        },
      });
    }

    pi.registerCommand("lead-fixture", {
      description: "Run the PI Lead isolated fixture",
      handler: async (_args, context) => {
        const request = { taskId: randomUUID(), assignmentId: randomUUID() };
        let summary: FixtureRunSummary;
        if (activeWorkerSlots() + 1 > MAX_ACTIVE_WORKERS) {
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
        activeRuns.set(controller, 1);
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
          releaseWorkerSlots(controller);
        }
      },
    });
  };
}

export default createLeadExtension({
  routeIntent: configuredIntentRouter(),
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
  async runOpenCodeGo(request, cwd, signal) {
    const { createNativeOpenCodeGoRuntime } = await import("./native-opencode-go-runtime.ts");
    const runtime = await createNativeOpenCodeGoRuntime({ cwd });
    return runReadOnlyOpenCodeGoTask(request, runtime, { signal });
  },
  async runProposedChange(request, cwd, signal) {
    const { createNativeProposedChangeRuntime } = await import(
      "./native-proposed-change-runtime.ts"
    );
    const runtime = await createNativeProposedChangeRuntime({ cwd });
    return runProposedChangeTask(request, runtime, { signal });
  },
  async runCompleteLocalCoding(request, cwd, signal) {
    const { createNativeReviewFixCommitRuntime } = await import(
      "./native-review-fix-commit-runtime.ts"
    );
    const runtime = await createNativeReviewFixCommitRuntime({ cwd });
    return runReviewFixCommitTask(request, runtime, { signal });
  },
});
