import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_ACTIVE_WORKERS } from "./policy.ts";
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
};

export function createLeadExtension(dependencies: LeadDependencies) {
  return (pi: ExtensionAPI): void => {
    const activeRuns = new Set<AbortController>();

    pi.on("session_shutdown", async () => {
      for (const controller of activeRuns) {
        controller.abort(new DOMException("Lead session closed", "AbortError"));
      }
    });

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
});
