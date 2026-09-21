type PlanningOptions = {
  idea: string;
  feature: string;
  researchAccess: "approved" | "not-approved";
};

type Interview = { decisions: readonly string[]; unresolvedFacts: readonly string[] };
type Research = { references: readonly string[] };
type Ticket = { number: number; slug: string; blockedBy: readonly number[] };

export type PlanningArtifacts = {
  specification: string;
  tickets: readonly string[];
  decisions: readonly string[];
  references: readonly string[];
  buildAuthorized: false;
};

function validFeature(feature: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature);
}

export function createPlanningWorkflow(options: PlanningOptions) {
  if (!options.idea.trim()) throw new Error("Planning idea is empty");
  if (!validFeature(options.feature)) throw new Error("Planning feature must be a lowercase slug");
  let interview: Interview | undefined;
  let research: Research | undefined;
  let specificationApproved = false;
  let published: PlanningArtifacts | undefined;

  return {
    next() {
      if (!interview) return { status: "INTERVIEW_REQUIRED" as const, skills: ["ask-matt", "grill-with-docs"] as const };
      if (interview.unresolvedFacts.length && !research) {
        return options.researchAccess === "approved"
          ? { status: "RESEARCH_REQUIRED" as const, skill: "research" as const }
          : { status: "RESEARCH_ACCESS_REQUIRED" as const };
      }
      if (!specificationApproved) return { status: "SPEC_APPROVAL_REQUIRED" as const };
      if (!published) return { status: "TICKET_GRANULARITY_APPROVAL_REQUIRED" as const };
      return { status: "PUBLISHED" as const, artifacts: published };
    },
    recordInterview(value: Interview) {
      if (interview) throw new Error("Planning interview is already recorded");
      interview = value;
    },
    recordResearch(value: Research) {
      if (!interview?.unresolvedFacts.length) throw new Error("Research was not requested");
      if (options.researchAccess !== "approved") throw new Error("Research network access is not approved");
      research = value;
    },
    approveSpecification() {
      if (!interview || (interview.unresolvedFacts.length && !research)) throw new Error("Specification is not ready for approval");
      specificationApproved = true;
    },
    approveTicketGranularity(tickets: readonly Ticket[]): PlanningArtifacts {
      if (!specificationApproved) throw new Error("Ticket publication requires specification approval");
      if (!tickets.length) throw new Error("At least one vertical ticket is required");
      for (const [index, ticket] of tickets.entries()) {
        if (ticket.number !== index + 1 || !validFeature(ticket.slug) || ticket.blockedBy.some((blocker) => blocker >= ticket.number || blocker < 1)) {
          throw new Error("Tickets must be numbered in dependency order with valid blocking edges");
        }
      }
      const root = `.scratch/${options.feature}`;
      published = {
        specification: `${root}/spec.md`,
        tickets: tickets.map((ticket) => `${root}/issues/${String(ticket.number).padStart(2, "0")}-${ticket.slug}.md`),
        decisions: [...interview!.decisions],
        references: [...(research?.references ?? [])],
        buildAuthorized: false,
      };
      return published;
    },
    requestWayfinder() {
      return { status: "UNAVAILABLE" as const, workflow: "WAYFIND" as const };
    },
  };
}
