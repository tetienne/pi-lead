# 18: Execute Matt workflows through one orchestrator

**What to build:** an ordinary request to the Lead is classified by bounded Jev
judgment and carried through the appropriate Matt workflow, worker lifecycle and
final summary without requiring the user to choose a provider, skill or internal
execution stage.

**Blocked by:** [17: Refocus the product contract on one Lead interface](17-refocus-product-contract.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Route CHAT, IMPLEMENT, IDEATE, DEBUG, REVIEW, RESEARCH, TRIAGE and WAYFIND
  from the same native Pi input seam; consequential ambiguity asks for
  clarification and OPERATE remains subject to deterministic human gates.
- [ ] Map admitted intents to the installed Matt skill contracts rather than a
  second workflow engine; code-changing paths include validation and independent
  review against the final revision.
- [ ] Apply deterministic policy after each Jev judgment, select and verify the
  effective model/reasoning route at worker spawn, and keep provider identity
  out of the user request.
- [ ] Reuse the existing isolated worker, debug/review, planning, recovery and
  result-correlation implementations where they satisfy the refocused contract;
  no duplicate lifecycle is introduced.
- [ ] A natural-language implementation request reaches an attributable result
  or precise BLOCKED outcome and reports checks, review, Git state and cleanup.
- [ ] Keep legacy commands temporarily as compatibility adapters only while this
  expanded path lands; they must invoke the same orchestration interface and are
  removed by Ticket 19.

## Context and constraints

The current Lead input handler executes only CHAT, IDEATE, TRIAGE and WAYFIND.
Other valid Jev outcomes tell the user to find another entry point, even though
implementation, debug, review and model-routing modules already exist. This
ticket closes that integration gap through one deep module whose interface is a
user request and whose implementation owns routing, workflow selection and
lifecycle coordination.

The trusted policy remains authoritative for permissions, network, credentials,
Git destinations, concurrency and DONE. Jev selects only among permitted
semantic choices. Important workers remain visible in named Herdr tabs and run
inside Gondolin.

## Validation and delivery

Test the orchestration interface rather than each private adapter. Cover normal
chat, every supported engineering intent, ambiguity, Jev outage/malformed
output, unavailable provider/model, follow-up versus new-task admission,
cancellation, recovery and final cleanup. Include at least one complete
implementation path using controlled adapters before any bounded live check.

## Primary context

- [Refocused product contract](17-refocus-product-contract.md)
- [Jev intent routing](10-jev-intent-routing.md)
- [Model and reasoning routing](11-model-reasoning-routing.md)
- [Planning workflow](12-idea-to-tickets.md)
- [Debug and review lifecycle](13-debug-and-review.md)
- [Triage and wayfinding](14-triage-and-wayfinding.md)
- [Recovery and retention](06-recovery-retention.md)
- [Approved standalone specification](../spec.md)

## Comments

Created from the 2026-09-22 scope audit and approved by the user. Tickets 06,
10, 11 and 13 are superseded historical slices; this ticket owns their
unfinished integration requirements rather than merely adding another command
beside them.

2026-09-22: Added the first unified-admission slice in commit `ea16dd2`.
Ordinary native input and `/lead <request>` now share one Jev admission
boundary. The boundary preserves CHAT in the Lead, dispatches IDEATE, TRIAGE
and WAYFIND to their installed Matt contracts, dispatches DEBUG, REVIEW and
RESEARCH to their installed Matt skill contracts, fails closed for ambiguity
and OPERATE, and routes a controlled IMPLEMENT request through the existing
validated, independently reviewed local-commit lifecycle. Legacy read,
implement, planning, triage and wayfinding adapters now enter that boundary.

The ticket remains ready-for-agent: independent Spec review found that
spawn-time model/reasoning verification, host-owned recovery admission, and
native DEBUG/REVIEW/RESEARCH lifecycle adapters are still not integrated. The
remaining legacy `lead-read-go`, `lead-change` and `lead-fixture` adapters also
need to cross the boundary before Ticket 19 contracts the public surface.
Validation for this slice: `npm test` (140 passing), `npm run typecheck`, and
`git diff --check` passed. Independent Standards review found no hard
repository-standard violation; it identified the remaining compatibility
adapter gap above.
