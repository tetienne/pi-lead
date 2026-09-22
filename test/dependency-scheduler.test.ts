import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DependencySchedulerStore,
  reconcileInterruptedFrontier,
  runDependencyFrontier,
  loadApprovedTicketGraph,
} from "../src/dependency-scheduler.ts";
import type { SchedulerClaim } from "../src/dependency-scheduler.ts";

function ownership(claim: SchedulerClaim) {
  return {
    ticketId: claim.ticket.id,
    assignmentId: claim.assignmentId,
    workerId: `worker-${claim.ticket.id}`,
    vmId: `vm-${claim.ticket.id}`,
    piSessionId: `session-${claim.ticket.id}`,
    tabId: `tab-${claim.ticket.id}`,
    paneId: `pane-${claim.ticket.id}`,
  };
}

async function approvedGraph(root: string, authorizedTicketIds = ["02", "03", "04"]) {
  await writeFile(join(root, "spec.md"), "# Example\n\nStatus: ready-for-agent\nApproval: approved by the user\n");
  await writeFile(join(root, "01-foundation.md"), "# 01: Foundation\n\n**Blocked by:** none\n\n**Status:** DONE\n\n## Acceptance criteria\n\n- [x] Foundation exists.\n");
  await writeFile(join(root, "02-independent.md"), "# 02: Independent\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n## Acceptance criteria\n\n- [ ] Independent work is verified.\n");
  await writeFile(join(root, "03-dependent.md"), "# 03: Dependent\n\n**Blocked by:** [01: Foundation](01-foundation.md)\n\n**Status:** ready-for-agent\n\n## Acceptance criteria\n\n- [ ] Dependent work is verified.\n");
  await writeFile(join(root, "04-waiting.md"), "# 04: Waiting\n\n**Blocked by:** [03: Dependent](03-dependent.md)\n\n**Status:** ready-for-agent\n\n## Acceptance criteria\n\n- [ ] Waiting work is verified.\n");
  return loadApprovedTicketGraph({ specificationPath: join(root, "spec.md"), ticketDirectory: root, authorizedTicketIds });
}

test("an approved local ticket graph exposes only ready tickets whose blockers are done", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root);

  assert.deepEqual(graph.frontier.map((ticket) => ticket.id), ["02", "03"]);
  assert.deepEqual(graph.tickets.find((ticket) => ticket.id === "04")?.blockedBy, ["03"]);
});

test("a ready ticket still needs explicit implementation authorization before it enters the frontier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root, ["02"]);

  assert.deepEqual(graph.frontier.map((ticket) => ticket.id), ["02"]);
  assert.equal(graph.tickets.find((ticket) => ticket.id === "03")?.implementationAuthorized, false);
});

test("the project’s approved specification is admitted without weakening its approval wording", async () => {
  const graph = await loadApprovedTicketGraph({
    specificationPath: join(process.cwd(), ".scratch", "pi-lead", "spec.md"),
    ticketDirectory: join(process.cwd(), ".scratch", "pi-lead", "issues"),
    authorizedTicketIds: ["15"],
  });

  assert.equal(graph.tickets.some((ticket) => ticket.id === "15"), true);
});

test("atomic claims give each eligible ticket one fresh context and interruption never resumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root);
  const stateRoot = join(root, "scheduler-state");
  const first = new DependencySchedulerStore({ root: stateRoot });
  const second = new DependencySchedulerStore({ root: stateRoot });
  await first.initialize(graph);

  const [one, two] = await Promise.all([
    first.claimFrontier(graph, { controllerId: "lead-one", availableWorkers: 1 }),
    second.claimFrontier(graph, { controllerId: "lead-two", availableWorkers: 1 }),
  ]);
  const claims = [...one, ...two];
  assert.deepEqual(claims.map((claim) => claim.ticket.id).sort(), ["02", "03"]);
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, 2);
  assert.equal(claims.every((claim) => claim.context.specificationDigest === graph.specificationDigest), true);

  const interrupted = await first.recoverInterrupted("lead-one");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.reason, "RESUME_CONFIRMATION_REQUIRED");
  assert.deepEqual(
    (await second.claimFrontier(graph, { controllerId: "lead-two", availableWorkers: 2 })).map((claim) => claim.ticket.id),
    [],
  );
});

test("the frontier uses no more than two workers and serializes overlapping integration with revalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root);
  const store = new DependencySchedulerStore({ root: join(root, "scheduler-state") });
  let activeWorkers = 0;
  let maximumWorkers = 0;
  const calls: string[] = [];
  const workerPhases: string[] = [];

  const summary = await runDependencyFrontier({
    graph,
    store,
    controllerId: "lead-one",
    runtime: {
      async execute({ claim, workers, recordWorkerOwnership }) {
        const useWorker = (phase: "build" | "standards-review" | "spec-review") => workers.use(1, async () => {
          activeWorkers++;
          maximumWorkers = Math.max(maximumWorkers, activeWorkers);
          workerPhases.push(`${phase}:${claim.ticket.id}`);
          if (phase === "build") await recordWorkerOwnership(ownership(claim));
          await Promise.resolve();
          activeWorkers--;
        });
        await useWorker("build");
        await Promise.all([useWorker("standards-review"), useWorker("spec-review")]);
        return {
          status: "VERIFIED",
          baseRevision: "base",
          verifiedRevision: `proposal-${claim.ticket.id}`,
          touchedPaths: claim.ticket.id === "02" ? ["src/feature"] : ["src/feature/widget.ts"],
          artifactIds: [`artifact-${claim.ticket.id}`],
          ownership: ownership(claim),
        };
      },
      async resolveOverlap(input) {
        calls.push(`resolve:${input.ticket.id}:${input.conflictingTicket.id}`);
        return { ...input.result, verifiedRevision: `merged-${input.ticket.id}` };
      },
      async revalidate(input) {
        calls.push(`revalidate:${input.ticket.id}:${input.currentRevision}`);
        return { ...input.result, verifiedRevision: input.currentRevision };
      },
      async integrate(input) {
        calls.push(`integrate:${input.ticket.id}:${input.result.verifiedRevision}`);
        return { status: "INTEGRATED", revision: `integrated-${input.ticket.id}` };
      },
    },
  });

  assert.equal(maximumWorkers, 2);
  assert.equal(workerPhases.filter((phase) => phase.startsWith("standards-review") || phase.startsWith("spec-review")).length, 4);
  assert.equal(summary.status, "DONE");
  assert.deepEqual(summary.completedTicketIds, ["02", "03"]);
  assert.deepEqual(calls, [
    "integrate:02:proposal-02",
    "revalidate:02:integrated-02",
    "resolve:03:02",
    "revalidate:03:integrated-02",
    "integrate:03:integrated-02",
    "revalidate:03:integrated-03",
  ]);
});

test("an interrupted frontier preserves its claims as blocked diagnostics and does not replay them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root);
  const store = new DependencySchedulerStore({ root: join(root, "scheduler-state") });
  const controller = new AbortController();
  controller.abort(new DOMException("Lead stopped", "AbortError"));

  const summary = await runDependencyFrontier({
    graph,
    store,
    controllerId: "lead-one",
    signal: controller.signal,
    runtime: {
      async execute() { throw controller.signal.reason; },
      async resolveOverlap() { throw new Error("interrupted work cannot integrate"); },
      async revalidate() { throw new Error("interrupted work cannot revalidate"); },
      async integrate() { throw new Error("interrupted work cannot integrate"); },
    },
  });

  assert.equal(summary.status, "BLOCKED");
  assert.deepEqual(summary.blocked.map((entry) => entry.reason), [
    "RESUME_CONFIRMATION_REQUIRED",
    "RESUME_CONFIRMATION_REQUIRED",
  ]);
  assert.deepEqual(
    await store.claimFrontier(graph, { controllerId: "lead-two", availableWorkers: 2 }),
    [],
  );
});

test("a forged worker result cannot complete the ticket it was not assigned", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root, ["02"]);
  const store = new DependencySchedulerStore({ root: join(root, "scheduler-state") });
  let integrated = false;

  const summary = await runDependencyFrontier({
    graph,
    store,
    controllerId: "lead-one",
    runtime: {
      async execute({ claim }) {
        return {
          status: "VERIFIED",
          baseRevision: "base",
          verifiedRevision: "proposal",
          touchedPaths: ["src/file.ts"],
          artifactIds: ["artifact"],
          ownership: { ...ownership(claim), assignmentId: "forged-assignment" },
        };
      },
      async resolveOverlap() { throw new Error("forged work cannot overlap"); },
      async revalidate() { throw new Error("forged work cannot revalidate"); },
      async integrate() { integrated = true; return { status: "INTEGRATED", revision: "never" }; },
    },
  });

  assert.equal(summary.status, "BLOCKED");
  assert.equal(summary.blocked[0]?.reason, "INTEGRATION_BLOCKED");
  assert.equal(integrated, false);
});

test("restart reconciliation stops an owned worker without replaying its assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  const graph = await approvedGraph(root, ["02"]);
  const store = new DependencySchedulerStore({ root: join(root, "scheduler-state") });
  await store.initialize(graph);
  const [claim] = await store.claimFrontier(graph, { controllerId: "lead-before-restart", availableWorkers: 1 });
  assert.ok(claim);
  await store.recordWorkerOwnership(claim, ownership(claim));
  const calls: string[] = [];
  let observed = 0;

  const reconciliation = await reconcileInterruptedFrontier({
    store,
    runtime: {
      async observe(worker) {
        calls.push(`observe:${worker.workerId}`);
        observed++;
        return observed === 1 ? "RUNNING" : "STOPPED";
      },
      async terminate(worker) {
        calls.push(`terminate:${worker.vmId}`);
        return true;
      },
    },
  });

  assert.deepEqual(calls, ["observe:worker-02", "terminate:vm-02", "observe:worker-02"]);
  assert.deepEqual(reconciliation.map((entry) => entry.reason), ["RESUME_CONFIRMATION_REQUIRED"]);
  assert.deepEqual(
    await store.claimFrontier(graph, { controllerId: "lead-after-restart", availableWorkers: 1 }),
    [],
  );
});

test("a ticket graph rejects an unresolved blocking edge instead of guessing a dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lead-scheduler-"));
  await writeFile(join(root, "spec.md"), "# Example\n\nStatus: ready-for-agent\nApproval: approved by the user\n");
  await writeFile(join(root, "01-orphan.md"), "# 01: Orphan\n\n**Blocked by:** [99: Missing](99-missing.md)\n\n**Status:** ready-for-agent\n\n## Acceptance criteria\n\n- [ ] Orphan is verified.\n");

  await assert.rejects(
    loadApprovedTicketGraph({ specificationPath: join(root, "spec.md"), ticketDirectory: root, authorizedTicketIds: ["01"] }),
    /unknown blocking ticket 99/i,
  );
});
