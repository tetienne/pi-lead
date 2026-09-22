import { randomUUID } from "node:crypto";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_ACTIVE_WORKERS } from "./policy.ts";
import {
  chooseWorkerRoute,
  verifyWorkerRoute,
  type EffectivePiRoute,
  type JevWorkerResourceJudgment,
  type WorkerRouteSelection,
  type WorkerRouteVerification,
  type WorkerRoutingState,
} from "./model-reasoning-routing.ts";
import { createJevIntentRouter, JEV_WORKFLOWS, type JevRoutingOutcome, type JevWorkflow } from "./jev-intent-routing.ts";
import { createOpenRouterJevTransport } from "./openrouter-jev-transport.ts";
import {
  resolveNaturalImplementationInput,
  type ResolvedImplementationInput,
} from "./implementation-intake.ts";
import { planningSkillPrompt } from "./planning-intake.ts";
import { triageSkillPrompt, wayfinderSkillPrompt } from "./tracker-intake.ts";
import { parseProposedChangeInput, type ParsedProposedChangeInput } from "./proposed-change-input.ts";
import { pinReviewSpecification, pinReviewStandards } from "./review-context.ts";
import {
  runProposedChangeTask,
  type ProposedChangeRequest,
  type ProposedChangeSummary,
} from "./proposed-change-task.ts";
import {
  runReviewFixCommitTask,
  type CompleteLocalCodingRequest,
  type CompleteLocalCodingSummary,
} from "./review-fix-commit-task.ts";
import {
  runDebugTask,
  runStandaloneBranchReview,
  type DebugTaskRequest,
  type DebugTaskSummary,
  type StandaloneBranchReviewRequest,
  type StandaloneBranchReviewSummary,
} from "./debug-review-task.ts";

export type WorkerRouteAuthorization = {
  state: WorkerRoutingState;
  judgment: JevWorkerResourceJudgment;
  currentState?(): WorkerRoutingState;
};

export type WorkerExecutionRoute = {
  selection: WorkerRouteSelection;
  verifySpawn(effective: EffectivePiRoute): WorkerRouteVerification;
};

export type RecoveryAdmission = {
  taskId: string;
  reason: string;
  resumeAllowed: boolean;
};

type LeadDependencies = {
  runCompleteLocalCoding?(
    request: CompleteLocalCodingRequest,
    cwd: string,
    signal: AbortSignal,
    route?: WorkerExecutionRoute,
  ): Promise<CompleteLocalCodingSummary>;
  runDebug?(
    request: DebugTaskRequest,
    cwd: string,
    signal: AbortSignal,
    route?: WorkerExecutionRoute,
  ): Promise<DebugTaskSummary>;
  runReview?(
    request: StandaloneBranchReviewRequest,
    cwd: string,
    signal: AbortSignal,
    route?: WorkerExecutionRoute,
  ): Promise<StandaloneBranchReviewSummary>;
  runResearch?(
    request: ProposedChangeRequest,
    cwd: string,
    signal: AbortSignal,
    route?: WorkerExecutionRoute,
  ): Promise<ProposedChangeSummary>;
  authorizeWorkerRoute?(input: {
    request: string;
    cwd: string;
    activeWorkers: number;
    requiredSlots: number;
  }): Promise<WorkerRouteAuthorization>;
  recoverInterrupted?(cwd: string): Promise<readonly RecoveryAdmission[]>;
  confirmRecovery?(cwd: string, taskId: string): Promise<void>;
  routeIntent?(input: string): Promise<JevRoutingOutcome>;
  resolveImplementationInput?(
    request: string,
    cwd: string,
  ): Promise<ResolvedImplementationInput>;
};

function parseStandaloneReviewInput(raw: string): {
  namedBase: string;
  reviewBranch: string;
  specSource?: string;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let namedBase: string | undefined;
  let reviewBranch: string | undefined;
  let specSource: string | undefined;
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`missing value for ${option ?? "option"}`);
    if (option === "--base" && namedBase === undefined) namedBase = value;
    else if (option === "--branch" && reviewBranch === undefined) reviewBranch = value;
    else if (option === "--spec" && specSource === undefined) specSource = value;
    else throw new Error(`unknown or repeated review option: ${option ?? ""}`);
  }
  if (!namedBase || !reviewBranch) throw new Error("review requires --base and --branch");
  if (specSource && (
    specSource.startsWith("/") || specSource.includes("\\") || specSource.includes("\0") ||
    specSource.split("/").some((part) => !part || part === "." || part === "..")
  )) throw new Error("--spec must be a confined relative Markdown path");
  return { namedBase, reviewBranch, ...(specSource ? { specSource } : {}) };
}

function explicitWorkflowFallback(raw: string): JevWorkflow | "AMBIGUOUS" | undefined {
  const input = raw.trim().toLowerCase();
  const matches: JevWorkflow[] = [];
  const add = (workflow: JevWorkflow, pattern: RegExp) => {
    if (pattern.test(input) && !matches.includes(workflow)) matches.push(workflow);
  };
  add("DEBUG", /\b(debug|diagnos(?:e|is)|bug|crash|regression|failing)\b/);
  add("REVIEW", /\b(review|audit|inspect (?:the )?branch)\b/);
  try {
    parseStandaloneReviewInput(raw);
    if (!matches.includes("REVIEW")) matches.push("REVIEW");
  } catch {
    // Other structured workflow inputs are classified by their semantic signal
    // or by the implementation default below.
  }
  add("RESEARCH", /\b(research|investigate|find out|compare options)\b/);
  add("TRIAGE", /\btriage\b/);
  add("WAYFIND", /\b(wayfind|map (?:the|this|a) (?:effort|migration|project))\b/);
  add("IDEATE", /\b(ideate|brainstorm|shape (?:this|an?|the) idea|plan (?:an?|the|this))\b/);
  add("OPERATE", /\b(operate|deploy|publish|merge|force[- ]?push|privileged)\b/);
  add("IMPLEMENT", /(?:^|\b)(implement|build|create|add|change|update|refactor)\b/);
  // Structured implementation, debug, research and review requests all begin
  // with --base. Treat that shape as IMPLEMENT only when no semantic or
  // review-specific signal selected another workflow.
  if (matches.length === 0) add("IMPLEMENT", /^--base\b/);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "AMBIGUOUS";
  if (/^(?:how|what|why|where|when|who|can|could|would|is|are|do|does)\b|\?$/.test(input)) return "CHAT";
  return undefined;
}

export function configuredIntentRouter(environment: NodeJS.ProcessEnv = process.env): LeadDependencies["routeIntent"] | undefined {
  const apiKey = environment.PI_LEAD_JEV_OPENROUTER_KEY;
  if (!apiKey) {
    return async () => ({ status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" });
  }
  const resetHourUtc = Number(environment.PI_LEAD_JEV_RESET_HOUR_UTC);
  if (
    environment.PI_LEAD_JEV_DEDICATED_KEY_CONFIRMED !== "yes" ||
    environment.PI_LEAD_JEV_PROVIDER_DAILY_CAP_USD !== "1" ||
    !Number.isInteger(resetHourUtc) || resetHourUtc < 0 || resetHourUtc > 23
  ) {
    return async () => ({ status: "SERVICE_UNAVAILABLE", reason: "JEV_UNAVAILABLE" });
  }
  const router = createJevIntentRouter({
    transport: createOpenRouterJevTransport({ apiKey }),
    getState: () => ({
      version: 1,
      availability: Object.fromEntries(JEV_WORKFLOWS.map((workflow) => [workflow, true])),
    }),
    budget: { dailyCapUsd: 1, reservationUsd: 0.01, resetHourUtc },
  });
  return router.route;
}

async function authorizeNativeChatGptRoute(input: {
  request: string;
  activeWorkers: number;
}): Promise<WorkerRouteAuthorization> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: true });
  const modelId = process.env.PI_LEAD_CHATGPT_MODEL ?? "gpt-5.6-luna";
  const available = await runtime.getAvailable("openai-codex");
  const currentState = (): WorkerRoutingState => {
    const authenticated = runtime.isUsingSubscription("openai-codex");
    const includedQuotaConfirmed = process.env.PI_LEAD_CHATGPT_INCLUDED_QUOTA_CONFIRMED === "yes";
    return {
      version: 1,
      activeWorkers: input.activeWorkers,
      maxActiveWorkers: MAX_ACTIVE_WORKERS,
      providers: {
        "openai-codex": { authenticated, quotaAvailable: authenticated && includedQuotaConfirmed },
        "opencode-go": { authenticated: false, quotaAvailable: false },
      },
      availableModels: {
        "openai-codex": available.map((model) => model.id),
        "opencode-go": [],
      },
      // The native subscription adapter has no paid API-key fallback. A worker
      // is still admitted only after the operator confirms included quota.
      budgetAvailable: authenticated && includedQuotaConfirmed,
      minimumConfidence: 0.8,
      routes: [{
        provider: "openai-codex",
        modelId,
        reasoning: "high",
        allowedEffectiveReasoning: ["medium", "high"],
        taskClasses: ["DEMANDING"],
        contextClasses: ["STANDARD", "LARGE"],
      }],
    };
  };
  const state = currentState();
  // Resource judgment is a preapproved conservative fallback: code-changing
  // and independent-review work always uses the demanding route. The approved
  // spec permits this when semantic resource judgment is unavailable, provided
  // the route satisfies freshly rechecked policy state.
  const judgment: JevWorkerResourceJudgment = {
    questionId: "worker-resource",
    type: "resource",
    stateVersion: state.version,
    taskClass: "DEMANDING",
    contextClass: input.request.length > 4_000 ? "LARGE" : "STANDARD",
    confidence: 1,
  };
  return { state, judgment, currentState };
}

export function createLeadExtension(dependencies: LeadDependencies) {
  return (pi: ExtensionAPI): void => {
    const activeRuns = new Map<AbortController, { slots: number; taskId: string }>();
    const queuedRuns: Array<{
      slots: number;
      taskId: string;
      controller: AbortController;
      resolve(controller: AbortController): void;
      reject(reason: unknown): void;
    }> = [];
    let shuttingDown = false;
    let recoveryPending = dependencies.recoverInterrupted !== undefined;
    let recoveryBlockers: readonly RecoveryAdmission[] = [];
    const activeWorkerSlots = () => [...activeRuns.values()].reduce((sum, run) => sum + run.slots, 0);
    const startQueuedRuns = () => {
      while (true) {
        const index = queuedRuns.findIndex((queued) =>
          activeWorkerSlots() + queued.slots <= MAX_ACTIVE_WORKERS,
        );
        if (index < 0) return;
        const queued = queuedRuns.splice(index, 1)[0];
        if (!queued) return;
        activeRuns.set(queued.controller, { slots: queued.slots, taskId: queued.taskId });
        queued.resolve(queued.controller);
      }
    };
    const reserveWorkerSlots = (slots: number, taskId: string): Promise<AbortController> => {
      const controller = new AbortController();
      if (shuttingDown) {
        controller.abort(new DOMException("Lead session closed", "AbortError"));
        return Promise.reject(controller.signal.reason);
      }
      if (activeWorkerSlots() + slots <= MAX_ACTIVE_WORKERS) {
        activeRuns.set(controller, { slots, taskId });
        return Promise.resolve(controller);
      }
      return new Promise((resolvePromise, reject) => {
        queuedRuns.push({ slots, taskId, controller, resolve: resolvePromise, reject });
      });
    };
    const releaseWorkerSlots = (controller: AbortController) => {
      activeRuns.delete(controller);
      startQueuedRuns();
    };
    const startPlanning = (idea: string, context: { ui: { notify(message: string, level: "info" | "error"): void } }) => {
      pi.sendUserMessage(planningSkillPrompt(idea), { expandPromptTemplates: true });
      context.ui.notify("PI Lead plan: sent to Ask Matt; no build was started", "info");
    };
    const startTriage = (request: string, context: { ui: { notify(message: string, level: "info" | "error"): void } }) => {
      pi.sendUserMessage(triageSkillPrompt(request), { expandPromptTemplates: true });
      context.ui.notify("PI Lead triage: sent to Matt; no build was started", "info");
    };
    const startWayfinding = (request: string, context: { ui: { notify(message: string, level: "info" | "error"): void } }) => {
      pi.sendUserMessage(wayfinderSkillPrompt(request), { expandPromptTemplates: true });
      context.ui.notify("PI Lead wayfinding: sent to Matt; no build was started", "info");
    };
    const startRoutedWorkflow = (
      workflow: "IDEATE" | "TRIAGE" | "WAYFIND",
      request: string,
      context: { ui: { notify(message: string, level: "info" | "error"): void } },
    ) => {
      if (workflow === "IDEATE") return startPlanning(request, context);
      if (workflow === "TRIAGE") return startTriage(request, context);
      return startWayfinding(request, context);
    };
    let runImplementation: ((
      args: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ) => Promise<void>) | undefined;
    let runDebugWorkflow: ((
      args: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ) => Promise<void>) | undefined;
    let runReviewWorkflow: ((
      args: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ) => Promise<void>) | undefined;
    const startResearch = async (
      request: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ): Promise<void> => {
      if (!dependencies.runResearch) {
        context.ui.notify("PI Lead research: unavailable; no worker was started", "error");
        return;
      }
      let parsed: ReturnType<typeof parseProposedChangeInput>;
      try {
        parsed = parseProposedChangeInput(request);
      } catch {
        context.ui.notify(
          "PI Lead research: clarification required — provide --base, --check, explicit --allow primary-source hosts, then -- and the research question/output note",
          "info",
        );
        return;
      }
      const task: ProposedChangeRequest = {
        taskId: randomUUID(), assignmentId: randomUUID(), repositoryPath: context.cwd,
        ...parsed,
        instruction: [
          "Follow the pinned Matt research skill. Investigate high-trust primary sources only, cite each material claim, and write one Markdown research note in the repository's existing research location.",
          `Research request: ${parsed.instruction}`,
        ].join("\n"),
      };
      const authorized = await authorizeExecutionRoute(request, context.cwd, 1);
      let summary: ProposedChangeSummary;
      if (authorized.error) {
        summary = {
          status: "BLOCKED", reason: "NATIVE_CONTROL_UNAVAILABLE", detail: authorized.error,
          taskId: task.taskId, assignmentId: task.assignmentId,
          diagnosticsRetained: false, resourcesStarted: false, vmTerminated: true,
        };
      } else {
        let controller: AbortController;
        try {
          controller = await reserveWorkerSlots(1, task.taskId);
        } catch (error) {
          summary = {
            status: "BLOCKED", reason: "NATIVE_CONTROL_UNAVAILABLE",
            detail: error instanceof Error ? error.message : String(error),
            taskId: task.taskId, assignmentId: task.assignmentId,
            diagnosticsRetained: false, resourcesStarted: false, vmTerminated: true,
          };
          pi.appendEntry("pi-lead:research-summary", summary);
          context.ui.notify(`PI Lead research: BLOCKED — ${summary.detail}`, "error");
          return;
        }
        try {
          summary = await dependencies.runResearch(task, context.cwd, controller.signal, authorized.route);
        } catch (error) {
          summary = {
            status: "BLOCKED", reason: "NATIVE_CONTROL_UNAVAILABLE",
            detail: error instanceof Error ? error.message : String(error),
            taskId: task.taskId, assignmentId: task.assignmentId,
            diagnosticsRetained: true, resourcesStarted: false, vmTerminated: false,
          };
        } finally {
          releaseWorkerSlots(controller);
        }
        if (authorized.route && summary.status === "REVIEW_REQUIRED" && authorized.evidence.length === 0) {
          summary = {
            ...summary,
            status: "BLOCKED", reason: "RUNTIME_FAILURE",
            detail: "No native research worker spawn supplied verified model/reasoning evidence",
            diagnosticsRetained: true,
          };
        }
      }
      pi.appendEntry("pi-lead:research-summary", { ...summary, workerRoutes: authorized.evidence });
      const detail = summary.status === "REVIEW_REQUIRED"
        ? `${summary.files.length} file(s), primary-source note proposed; human review required`
        : summary.detail ?? summary.reason;
      context.ui.notify(
        `PI Lead research: ${summary.status} — ${detail}`,
        summary.status === "REVIEW_REQUIRED" ? "info" : "error",
      );
    };
    const authorizeExecutionRoute = async (
      request: string,
      cwd: string,
      requiredSlots: number,
    ): Promise<{ route?: WorkerExecutionRoute; evidence: WorkerRouteVerification[]; error?: string }> => {
      if (!dependencies.authorizeWorkerRoute) return { evidence: [] };
      let authorization: WorkerRouteAuthorization;
      try {
        authorization = await dependencies.authorizeWorkerRoute({
          request,
          cwd,
          activeWorkers: activeWorkerSlots(),
          requiredSlots,
        });
      } catch (error) {
        return { evidence: [], error: error instanceof Error ? error.message : String(error) };
      }
      const selected = chooseWorkerRoute({ state: authorization.state, judgment: authorization.judgment });
      if (selected.status !== "READY") return { evidence: [], error: `worker route ${selected.reason}` };
      const evidence: WorkerRouteVerification[] = [];
      return {
        evidence,
        route: {
          selection: selected.selection,
          verifySpawn(effective) {
            const verification = verifyWorkerRoute({
              state: authorization.currentState?.() ?? authorization.state,
              judgment: authorization.judgment,
              selection: selected.selection,
              effective,
            });
            evidence.push(verification);
            if (verification.status === "BLOCKED") {
              throw new Error(`Worker route verification failed: ${verification.reason}`);
            }
            return verification;
          },
        },
      };
    };
    /** The sole conversation-first admission boundary. */
    const admitRequest = async (
      request: string,
      context: { cwd: string; ui: { notify(message: string, level: "info" | "error"): void } },
    ): Promise<"continue" | "handled"> => {
      const recoveryConfirmation = /^resume interrupted task ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/i.exec(request.trim());
      if (recoveryConfirmation?.[1]) {
        const blocker = recoveryBlockers.find((item) => item.taskId === recoveryConfirmation[1]);
        if (!blocker?.resumeAllowed || !dependencies.confirmRecovery) {
          context.ui.notify("PI Lead recovery: confirmation cannot safely resume that task", "error");
          return "handled";
        }
        try {
          await dependencies.confirmRecovery(context.cwd, blocker.taskId);
          recoveryBlockers = recoveryBlockers.filter((item) => item.taskId !== blocker.taskId);
          context.ui.notify(`PI Lead recovery: ${blocker.taskId} explicitly superseded; resubmit the request to start a fresh attributable attempt`, "info");
        } catch (error) {
          context.ui.notify(`PI Lead recovery: BLOCKED — ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return "handled";
      }
      if (!dependencies.routeIntent) {
        context.ui.notify("PI Lead intent: routing unavailable; no worker was started", "error");
        return "handled";
      }
      let outcome: JevRoutingOutcome;
      try {
        outcome = await dependencies.routeIntent(request);
      } catch {
        context.ui.notify("PI Lead intent: routing unavailable; no worker was started", "error");
        return "handled";
      }
      if (outcome.status === "SERVICE_UNAVAILABLE") {
        const fallback = explicitWorkflowFallback(request);
        if (fallback === "AMBIGUOUS") {
          context.ui.notify("PI Lead intent: clarification required; no worker was started", "info");
          return "handled";
        }
        if (fallback) outcome = { status: "ROUTED", workflow: fallback, source: "explicit" };
      }
      if (outcome.status === "ROUTED") {
        if (outcome.workflow === "CHAT") return "continue";
        if (recoveryPending || recoveryBlockers.length > 0) {
          const detail = recoveryPending
            ? "restart reconciliation is still running"
            : `${recoveryBlockers[0]?.taskId}: ${recoveryBlockers[0]?.reason.toLowerCase().replaceAll("_", " ")}`;
          context.ui.notify(`PI Lead recovery: BLOCKED — ${detail}; no new task was started`, "error");
          return "handled";
        }
        if (outcome.workflow === "IDEATE" || outcome.workflow === "TRIAGE" || outcome.workflow === "WAYFIND") {
          try {
            startRoutedWorkflow(outcome.workflow, request, context);
          } catch (error) {
            context.ui.notify(`PI Lead ${outcome.workflow.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return "handled";
        }
        if (outcome.workflow === "IMPLEMENT") {
          if (!runImplementation) {
            context.ui.notify("PI Lead implement: unavailable; no worker was started", "error");
          } else {
            await runImplementation(request, context);
          }
          return "handled";
        }
        if (outcome.workflow === "DEBUG") {
          if (!runDebugWorkflow) context.ui.notify("PI Lead debug: unavailable; no worker was started", "error");
          else await runDebugWorkflow(request, context);
          return "handled";
        }
        if (outcome.workflow === "REVIEW") {
          if (!runReviewWorkflow) context.ui.notify("PI Lead review: unavailable; no worker was started", "error");
          else await runReviewWorkflow(request, context);
          return "handled";
        }
        if (outcome.workflow === "RESEARCH") {
          try {
            await startResearch(request, context);
          } catch (error) {
            context.ui.notify(`PI Lead research: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return "handled";
        }
        // OPERATE is intentionally not a worker workflow. Jev can describe an
        // operation but cannot grant the human authorization that policy needs.
        context.ui.notify("PI Lead operation: human authorization required; no worker was started", "info");
        return "handled";
      }
      if (outcome.status === "SERVICE_UNAVAILABLE") return "continue";
      if (outcome.status === "CLARIFICATION_REQUIRED") {
        context.ui.notify("PI Lead intent: clarification required; no worker was started", "info");
        return "handled";
      }
      if (outcome.status === "UNAVAILABLE") {
        context.ui.notify(`PI Lead intent: ${outcome.workflow} is unavailable; no worker was started`, "info");
        return "handled";
      }
      context.ui.notify("PI Lead intent: routing unavailable; no worker was started", "error");
      return "handled";
    };

    if (dependencies.recoverInterrupted) {
      pi.on("session_start", async (_event, context) => {
        recoveryPending = true;
        try {
          recoveryBlockers = await dependencies.recoverInterrupted?.(context.cwd) ?? [];
          for (const recovery of recoveryBlockers) {
            pi.appendEntry("pi-lead:recovery-summary", recovery);
            context.ui.notify(
              `PI Lead recovery: ${recovery.taskId} BLOCKED — ${recovery.reason.toLowerCase().replaceAll("_", " ")}`,
              recovery.resumeAllowed ? "info" : "error",
            );
          }
        } catch (error) {
          recoveryBlockers = [{
            taskId: "unknown",
            reason: error instanceof Error ? error.message : String(error),
            resumeAllowed: false,
          }];
          context.ui.notify(`PI Lead recovery: BLOCKED — ${recoveryBlockers[0]?.reason}`, "error");
        } finally {
          recoveryPending = false;
        }
      });
    }

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

    if (dependencies.routeIntent) {
      pi.on("input", async (event, context) => {
        if (event.source === "extension" || event.streamingBehavior !== undefined || event.images?.length) {
          return { action: "continue" };
        }
        const action = await admitRequest(event.text, context);
        return { action };
      });
    }

    pi.registerCommand("lead", {
      description: "Admit a natural-language request through PI Lead",
      handler: async (args, context) => {
        await admitRequest(args, context);
      },
    });

    if (dependencies.runDebug) {
      const runDebug = dependencies.runDebug;
      runDebugWorkflow = async (args, context) => {
        let parsed: ReturnType<typeof parseProposedChangeInput>;
        try {
          parsed = parseProposedChangeInput(args);
          if (!parsed.specSource) throw new Error("debug request requires --spec");
        } catch {
          context.ui.notify(
            "PI Lead debug: clarification required — provide --base, --check, --spec, then -- and the symptom",
            "info",
          );
          return;
        }
        let specification: CompleteLocalCodingRequest["specification"];
        let standards: CompleteLocalCodingRequest["standards"];
        try {
          [specification, standards] = await Promise.all([
            pinReviewSpecification(context.cwd, parsed.specSource!),
            pinReviewStandards(context.cwd),
          ]);
        } catch (error) {
          context.ui.notify(`PI Lead debug: BLOCKED — ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        const taskId = randomUUID();
        const request: DebugTaskRequest = {
          task: { taskId, repositoryPath: context.cwd, ...parsed, specification, standards },
          symptom: parsed.instruction,
          feedbackId: randomUUID(),
          feedbackCommand: `mise run ${parsed.validationTasks[0]}`,
        };
        const authorized = await authorizeExecutionRoute(args, context.cwd, 2);
        let summary: DebugTaskSummary;
        if (authorized.error) {
          summary = { status: "BLOCKED", reason: "DIAGNOSIS_FAILED", detail: authorized.error, diagnosticsRetained: true };
        } else {
          let controller: AbortController;
          try {
            controller = await reserveWorkerSlots(2, request.task.taskId);
          } catch (error) {
            summary = { status: "BLOCKED", reason: "IMPLEMENTATION_BLOCKED", detail: error instanceof Error ? error.message : String(error), diagnosticsRetained: true };
            pi.appendEntry("pi-lead:debug-task-summary", summary);
            context.ui.notify(`PI Lead debug: BLOCKED — ${summary.detail}`, "error");
            return;
          }
          try {
            summary = await runDebug(request, context.cwd, controller.signal, authorized.route);
          } catch (error) {
            summary = { status: "BLOCKED", reason: "DIAGNOSIS_FAILED", detail: error instanceof Error ? error.message : String(error), diagnosticsRetained: true };
          } finally {
            releaseWorkerSlots(controller);
          }
          if (authorized.route && summary.status === "DONE" && authorized.evidence.length === 0) {
            summary = { status: "BLOCKED", reason: "INVALID_EVIDENCE", detail: "No native worker spawn supplied verified model/reasoning evidence", diagnosticsRetained: true };
          }
        }
        pi.appendEntry("pi-lead:debug-task-summary", { ...summary, workerRoutes: authorized.evidence });
        const detail = summary.status === "DONE"
          ? `fixed and committed ${summary.implementation.commit.commit}; feedback ${summary.verification.command} passed; cleanup confirmed`
          : summary.detail;
        context.ui.notify(`PI Lead debug: ${summary.status} — ${detail}`, summary.status === "DONE" ? "info" : "error");
      };
    }

    if (dependencies.runReview) {
      const runReview = dependencies.runReview;
      runReviewWorkflow = async (args, context) => {
        let parsed: ReturnType<typeof parseStandaloneReviewInput>;
        try {
          parsed = parseStandaloneReviewInput(args);
        } catch {
          context.ui.notify(
            "PI Lead review: clarification required — provide --base <branch-or-tag> --branch <branch> and optional --spec <path>",
            "info",
          );
          return;
        }
        let standards: CompleteLocalCodingRequest["standards"];
        let specification: CompleteLocalCodingRequest["specification"] | undefined;
        try {
          [standards, specification] = await Promise.all([
            pinReviewStandards(context.cwd),
            parsed.specSource ? pinReviewSpecification(context.cwd, parsed.specSource) : Promise.resolve(undefined),
          ]);
        } catch (error) {
          context.ui.notify(`PI Lead review: BLOCKED — ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        const request: StandaloneBranchReviewRequest = {
          taskId: randomUUID(), repositoryPath: context.cwd,
          namedBase: parsed.namedBase, reviewBranch: parsed.reviewBranch,
          ...(specification ? { specification } : {}), standards,
        };
        const authorized = await authorizeExecutionRoute(args, context.cwd, specification ? 2 : 1);
        let summary: StandaloneBranchReviewSummary;
        if (authorized.error) {
          summary = { status: "BLOCKED", taskId: request.taskId, reason: "REVIEW_FAILED", detail: authorized.error, reports: [], diagnosticsRetained: true };
        } else {
          let controller: AbortController;
          try {
            controller = await reserveWorkerSlots(specification ? 2 : 1, request.taskId);
          } catch (error) {
            summary = { status: "BLOCKED", taskId: request.taskId, reason: "REVIEW_FAILED", detail: error instanceof Error ? error.message : String(error), reports: [], diagnosticsRetained: true };
            pi.appendEntry("pi-lead:standalone-review-summary", summary);
            context.ui.notify(`PI Lead review: BLOCKED — ${summary.detail}`, "error");
            return;
          }
          try {
            summary = await runReview(request, context.cwd, controller.signal, authorized.route);
          } catch (error) {
            summary = { status: "BLOCKED", taskId: request.taskId, reason: "REVIEW_FAILED", detail: error instanceof Error ? error.message : String(error), reports: [], diagnosticsRetained: true };
          } finally {
            releaseWorkerSlots(controller);
          }
          if (authorized.route && summary.status === "DONE" && authorized.evidence.length === 0) {
            summary = { status: "BLOCKED", taskId: request.taskId, reason: "REVIEW_EVIDENCE_INVALID", detail: "No native reviewer spawn supplied verified model/reasoning evidence", reports: [], diagnosticsRetained: true };
          }
        }
        pi.appendEntry("pi-lead:standalone-review-summary", { ...summary, workerRoutes: authorized.evidence });
        const detail = summary.status === "DONE"
          ? `${summary.reports.length} independent report(s); read-only Git state confirmed; publication deferred`
          : summary.detail;
        context.ui.notify(`PI Lead review: ${summary.status} — ${detail}`, summary.status === "DONE" ? "info" : "error");
      };
    }

    if (dependencies.runCompleteLocalCoding) {
      const runCompleteLocalCoding = dependencies.runCompleteLocalCoding;
      runImplementation = async (args, context) => {
        let parsed: ParsedProposedChangeInput & Pick<ResolvedImplementationInput, "pinnedSpecification">;
        try {
          parsed = parseProposedChangeInput(args);
        } catch (error) {
          try {
            if (!dependencies.resolveImplementationInput) {
              throw new Error("repository context could not be resolved automatically");
            }
            parsed = await dependencies.resolveImplementationInput(args, context.cwd);
          } catch (resolutionError) {
            context.ui.notify(
              `PI Lead implement: clarification required — ${resolutionError instanceof Error ? resolutionError.message : String(resolutionError)}`,
              "info",
            );
            return;
          }
        }
        let specification: CompleteLocalCodingRequest["specification"];
        let standards: CompleteLocalCodingRequest["standards"];
        try {
          [specification, standards] = await Promise.all([
            parsed.pinnedSpecification ?? (
              parsed.specSource
                ? pinReviewSpecification(context.cwd, parsed.specSource)
                : Promise.reject(new Error("implement request requires --spec <relative-markdown-path>"))
            ),
            pinReviewStandards(context.cwd),
          ]);
        } catch (error) {
          context.ui.notify(
            `PI Lead implement: BLOCKED — ${error instanceof Error ? error.message : String(error)}`,
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
        let route: WorkerExecutionRoute | undefined;
        let workerRoutes: WorkerRouteVerification[] = [];
        const blockBeforeWorkerStart = (detail: string) => {
          const summary: CompleteLocalCodingSummary = {
            status: "BLOCKED",
            taskId: request.taskId,
            reason: "BUILD_BLOCKED",
            detail,
            reviews: [],
            reviewHistory: [],
            reviewCycles: 0,
            diagnosticsRetained: true,
            specification,
            standards,
          };
          pi.appendEntry("pi-lead:complete-task-summary", summary);
          context.ui.notify(`PI Lead implement: BLOCKED — ${detail}`, "error");
        };
        const authorized = await authorizeExecutionRoute(args, context.cwd, 2);
        route = authorized.route;
        workerRoutes = authorized.evidence;
        if (authorized.error) {
          blockBeforeWorkerStart(authorized.error);
          return;
        }
        let summary: CompleteLocalCodingSummary;
        // This task can have its Standards and Spec reviewers active together, so it
        // reserves both permitted worker slots for the whole lifecycle and queues
        // behind already-running work instead of overcommitting reviewer capacity.
        if (activeWorkerSlots() + 2 > MAX_ACTIVE_WORKERS) {
          context.ui.notify("PI Lead implement: QUEUED — waiting for two review slots", "info");
        }
        let controller: AbortController;
        try {
          controller = await reserveWorkerSlots(2, request.taskId);
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
          summary = await runCompleteLocalCoding(request, context.cwd, controller.signal, route);
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
        if (route && summary.status === "DONE" && workerRoutes.length === 0) {
          summary = {
            status: "BLOCKED",
            taskId: request.taskId,
            reason: "BUILD_BLOCKED",
            detail: "No native worker spawn supplied verified model/reasoning evidence",
            proposal: summary.proposal,
            commit: summary.commit,
            reviews: summary.reviews,
            reviewHistory: summary.reviewHistory,
            reviewCycles: summary.reviewCycles,
            diagnosticsRetained: true,
            specification,
            standards,
          };
        }
        pi.appendEntry("pi-lead:complete-task-summary", {
          ...summary,
          ...(route ? { workerRoutes } : {}),
        });
        const detail =
          summary.status === "DONE"
            ? [
                `committed ${summary.commit.commit} on ${summary.commit.branchName}`,
                `checks ${summary.proposal.validations.map((check) => check.task).join(", ") || "none reported"}`,
                `review ${summary.reviews.map((review) => review.axis).join("+") || "none reported"}`,
                `route ${workerRoutes.filter((item) => item.status === "VERIFIED").map((item) => `${item.selection.modelId}/${item.effectiveReasoning}`).join(", ") || "legacy"}`,
                `cleanup ${summary.proposal.vmTerminated && summary.reviews.every((review) => review.vmTerminated && review.tabClosed) ? "confirmed" : "unconfirmed"}`,
                `publication ${summary.published ? "complete" : "deferred"}`,
              ].join("; ")
            : summary.detail;
        context.ui.notify(
          `PI Lead implement: ${summary.status} — ${detail}`,
          summary.status === "DONE" ? "info" : "error",
        );
      };
    }
  };
}

export default createLeadExtension({
  routeIntent: configuredIntentRouter(),
  resolveImplementationInput: resolveNaturalImplementationInput,
  authorizeWorkerRoute: authorizeNativeChatGptRoute,
  async recoverInterrupted(cwd) {
    const { recoverNativeInterruptedTasks } = await import("./native-task-recovery.ts");
    return recoverNativeInterruptedTasks({ cwd });
  },
  async confirmRecovery(cwd, taskId) {
    const { projectTaskStateRoot } = await import("./native-task-recovery.ts");
    const { TaskRecordStore } = await import("./task-recovery.ts");
    await new TaskRecordStore({ root: projectTaskStateRoot(cwd) }).confirmRecovery(taskId);
  },
  async runResearch(request, cwd, signal, route) {
    const { createNativeProposedChangeRuntime } = await import("./native-proposed-change-runtime.ts");
    const { createNativeTaskJournal } = await import("./native-task-journal.ts");
    if (route?.selection.provider !== "openai-codex") {
      throw new Error("The current release requires an approved ChatGPT research route");
    }
    const journal = await createNativeTaskJournal({
      cwd, taskId: request.taskId, workflow: "RESEARCH", namedBase: request.namedBase,
      branchName: `pi-lead/research-${request.taskId}`,
    });
    const runtime = await createNativeProposedChangeRuntime({
      cwd, stateRoot: journal.stateRoot, workerMode: "research", workerPhase: "BUILD",
      modelId: route.selection.modelId, reasoning: route.selection.reasoning,
      onWorkerSpawn: route.verifySpawn,
      onWorkerOwned: journal.workerStarted, onWorkerResult: journal.workerObserved,
      onWorkerCleaned: journal.workerCleaned,
    });
    const summary = await runProposedChangeTask(request, runtime, { signal });
    await journal.recordChange(summary);
    return summary;
  },
  async runCompleteLocalCoding(request, cwd, signal, route) {
    const { createNativeReviewFixCommitRuntime } = await import(
      "./native-review-fix-commit-runtime.ts"
    );
    if (route?.selection.provider !== "openai-codex") {
      throw new Error("The current release requires an approved ChatGPT worker route");
    }
    const { createNativeTaskJournal } = await import("./native-task-journal.ts");
    const journal = await createNativeTaskJournal({
      cwd, taskId: request.taskId, workflow: "IMPLEMENT", namedBase: request.namedBase,
      branchName: `pi-lead/task-${request.taskId}`,
    });
    const runtime = await createNativeReviewFixCommitRuntime({
      cwd,
      stateRoot: journal.stateRoot,
      modelId: route.selection.modelId,
      reasoning: route.selection.reasoning,
      onWorkerSpawn: route.verifySpawn,
      onWorkerOwned: journal.workerStarted,
      onWorkerResult: journal.workerObserved,
      onWorkerCleaned: journal.workerCleaned,
    });
    const summary = await runReviewFixCommitTask(request, runtime, { signal });
    await journal.recordImplementation(summary);
    return summary;
  },
  async runDebug(request, cwd, signal, route) {
    const { createNativeDebugRuntime } = await import("./native-debug-review-runtime.ts");
    if (route?.selection.provider !== "openai-codex") {
      throw new Error("The current release requires an approved ChatGPT worker route");
    }
    const { createNativeTaskJournal } = await import("./native-task-journal.ts");
    const journal = await createNativeTaskJournal({
      cwd, taskId: request.task.taskId, workflow: "DEBUG", namedBase: request.task.namedBase,
      branchName: `pi-lead/task-${request.task.taskId}`,
    });
    const runtime = await createNativeDebugRuntime({
      cwd,
      stateRoot: journal.stateRoot,
      modelId: route.selection.modelId,
      reasoning: route.selection.reasoning,
      onWorkerSpawn: route.verifySpawn,
      onWorkerOwned: journal.workerStarted,
      onWorkerResult: journal.workerObserved,
      onWorkerCleaned: journal.workerCleaned,
    });
    const summary = await runDebugTask(request, runtime, { signal });
    await journal.recordDebug(summary);
    return summary;
  },
  async runReview(request, cwd, signal, route) {
    const { createNativeStandaloneBranchReviewRuntime } = await import("./native-debug-review-runtime.ts");
    if (route?.selection.provider !== "openai-codex") {
      throw new Error("The current release requires an approved ChatGPT worker route");
    }
    const { createNativeTaskJournal } = await import("./native-task-journal.ts");
    const journal = await createNativeTaskJournal({
      cwd, taskId: request.taskId, workflow: "REVIEW", namedBase: request.namedBase,
      branchName: request.reviewBranch,
    });
    const runtime = await createNativeStandaloneBranchReviewRuntime({
      cwd,
      stateRoot: journal.stateRoot,
      modelId: route.selection.modelId,
      reasoning: route.selection.reasoning,
      onWorkerSpawn: route.verifySpawn,
      onWorkerOwned: journal.workerStarted,
      onWorkerResult: journal.workerObserved,
      onWorkerCleaned: journal.workerCleaned,
    });
    const summary = await runStandaloneBranchReview(request, runtime, { signal });
    await journal.recordReview(summary);
    return summary;
  },
});
