import assert from "node:assert/strict";
import { test } from "node:test";

import { createPlanningWorkflow } from "../src/planning-workflow.ts";

test("a planning idea preserves decisions and requires spec and ticket approval before publishing tracker artifacts", () => {
  const workflow = createPlanningWorkflow({
    idea: "Add a safe release-notes workflow",
    feature: "release-notes",
    researchAccess: "approved",
  });

  assert.deepEqual(workflow.next(), { status: "INTERVIEW_REQUIRED", skills: ["ask-matt", "grill-with-docs"] });
  workflow.recordInterview({
    decisions: ["Release notes require a human publication gate"],
    unresolvedFacts: ["GitHub release API supports draft notes"],
  });
  assert.deepEqual(workflow.next(), { status: "RESEARCH_REQUIRED", skill: "research" });
  workflow.recordResearch({ references: ["https://docs.github.com/rest/releases/releases"] });
  assert.deepEqual(workflow.next(), { status: "SPEC_APPROVAL_REQUIRED" });
  workflow.approveSpecification();
  assert.deepEqual(workflow.next(), { status: "TICKET_GRANULARITY_APPROVAL_REQUIRED" });
  const artifacts = workflow.approveTicketGranularity([
    { number: 1, slug: "draft-notes", blockedBy: [] },
    { number: 2, slug: "publish-notes", blockedBy: [1] },
  ]);

  assert.equal(artifacts.specification, ".scratch/release-notes/spec.md");
  assert.deepEqual(artifacts.tickets, [
    ".scratch/release-notes/issues/01-draft-notes.md",
    ".scratch/release-notes/issues/02-publish-notes.md",
  ]);
  assert.deepEqual(artifacts.decisions, ["Release notes require a human publication gate"]);
  assert.deepEqual(artifacts.references, ["https://docs.github.com/rest/releases/releases"]);
  assert.equal(artifacts.buildAuthorized, false);
});

test("research access and Wayfinder remain explicit gates", () => {
  const noResearch = createPlanningWorkflow({ idea: "x", feature: "x", researchAccess: "not-approved" });
  noResearch.recordInterview({ decisions: [], unresolvedFacts: ["a fact"] });
  assert.deepEqual(noResearch.next(), { status: "RESEARCH_ACCESS_REQUIRED" });
  assert.deepEqual(noResearch.requestWayfinder(), { status: "UNAVAILABLE", workflow: "WAYFIND" });
});
