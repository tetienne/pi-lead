# 17: Refocus the product contract on one Lead interface

**What to build:** the project has one approved, conversation-first product
contract in which the user talks to the Lead, Jev supplies bounded judgments,
Matt skills define the engineering workflow, and provider/lifecycle details
remain internal.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

**Resolution:** DONE

## Acceptance criteria

- [x] Define ordinary conversation as the primary interface and at most one
  explicit Lead workflow escape hatch; provider, skill and lifecycle-stage
  selection are not user responsibilities.
- [x] Inventory every current Lead command and feature module, classifying each
  as product core, internal adapter, development-only evidence or deferred work.
- [x] Preserve the security invariants that earn their complexity: deterministic
  policy, worker isolation, credential mediation, attributable results,
  validation/review and confirmed cleanup.
- [x] Explicitly decide the current status of advanced scheduling, recovery,
  automatic publication, cache optimization, Linux support and OpenCode Go;
  implemented code is not automatically part of the current product.
- [x] Amend the standalone specification, ticket graph and user documentation
  so they describe the same narrowed product and retain links to historical
  implementation evidence without presenting it as integrated behavior.

## Context and constraints

The original target experience is one persistent Lead tab and ordinary requests
such as “implement X”, “debug Y” and “review this branch”. Explicit commands are
escape hatches, not a menu of providers, skills or orchestration stages. Jev
judges within policy; it does not grant authority. Matt's installed skills are
the engineering workflow; PI Lead must not invent a second SDLC.

This is the prefactoring ticket for the cleanup. It changes the authoritative
contract before code is removed or rewired, so later tickets can distinguish an
intentional internal adapter from accidental public surface. Do not discard
isolation or lifecycle safeguards merely to reduce file count.

## Validation and delivery

Review the amended contract against the bootstrap brief, domain glossary, ADRs,
current command discovery and actual source reachability. The result must name
the exact public interaction surface, the current release boundary and the
disposition of every existing command/module. Obtain human confirmation for any
choice that changes the approved boundary beyond the narrowing already accepted
on 2026-09-22.

## Primary context

- [Bootstrap brief](../../../PI_LEAD_BOOTSTRAP.md)
- [Approved standalone specification](../spec.md)
- [Current ticket graph](../ticket-proposal.md)
- [Domain glossary](../../../CONTEXT.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)

## Comments

Created after the 2026-09-22 scope audit. The audit found eight public Lead
commands spanning providers, workflow stages and development fixtures, while
several modules marked DONE were not reachable from the main Lead extension.
The user approved this ticket and the 17 → 18 → 19 → 20 cleanup sequence.

Implemented 2026-09-22. The standalone specification now makes ordinary Lead
conversation the primary interface and `/lead <request>` the sole explicit
escape hatch. It inventories all eight currently registered commands, both
special text forms and all 45 `src/` modules, including their current
reachability and their product-core, internal-adapter, development-evidence or
deferred disposition.

The current release is macOS arm64 with ChatGPT Pro and bounded Jev judgment.
Recovery remains product core. Automatic publication, advanced
dependency-frontier scheduling, cache optimization, Linux and OpenCode Go are
deferred; local reviewed commits remain in scope. Deterministic policy,
whole-worker isolation, credential mediation, result attribution,
final-revision validation/review and confirmed cleanup remain non-negotiable.
The ticket graph, README, affected historical tickets and superseded release
evidence now use the same boundary.

Validation: command discovery and the 45-module inventory were mechanically
cross-checked against `src/lead.ts` and `src/*.ts`; `git diff --check`,
`npm run typecheck` and the full 138-test suite pass. Review corrections aligned
ticket status with the canonical triage roles, made downstream blockers
explicit and closed the command/publication ambiguities in Tickets 19 and 20.
