# 19: Contract the public surface and remove orphan paths

**What to build:** the installed package exposes only the Lead interaction
approved in Ticket 17, while provider adapters, Matt workflow selection,
fixtures and lifecycle stages remain private implementation or explicit
development tooling.

**Blocked by:** [18: Execute Matt workflows through one orchestrator](18-unified-orchestration.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Remove the provider-, skill- and stage-specific public commands replaced
  by the unified orchestrator; retain only the approved escape hatch and any
  explicitly approved operational commands such as status or cancel.
- [ ] Keep fixture and live-proof runners available as development scripts
  without registering them as product workflows.
- [ ] Every shipped feature module is reachable from the Lead through the
  approved interface or explicitly identified as an internal adapter; delete or
  exclude orphan and deferred implementations from the release path.
- [ ] Provider availability changes routing policy, not the command vocabulary;
  OpenCode Go and future providers can be added or removed without teaching the
  user a new interaction.
- [ ] Preserve deterministic policy, worker isolation, credential confinement,
  review requirements, result correlation and cleanup while contracting the
  surface.
- [ ] Update command-discovery tests, package contents and README examples so no
  removed command is advertised or silently required.

## Context and constraints

This is the contract phase of the expand–contract cleanup. Ticket 18 first adds
the unified path beside the historical commands. This ticket removes those
compatibility paths only after their behavior is covered through the new
interface. Avoid wrappers that merely rename all existing commands; the goal is
one deep orchestration interface, not a command dispatcher with the same leaked
concepts.

Do not delete historical tracker evidence or weaken a safety check because its
current module is awkward. If a capability is deferred by Ticket 17, remove it
from the active package path while retaining the decision and evidence needed to
restore it deliberately later.

## Validation and delivery

Inspect native Pi command discovery from a fresh consuming project. Verify that
removed commands are absent, the approved escape hatch reaches the same
orchestrator as natural language, development fixtures still run directly, and
the source/package reachability inventory contains no unexplained feature
islands. Run the full deterministic suite and typecheck after contraction.

## Primary context

- [Refocused product contract](17-refocus-product-contract.md)
- [Unified orchestration](18-unified-orchestration.md)
- [Bootstrap brief](../../../PI_LEAD_BOOTSTRAP.md)
- [Approved standalone specification](../spec.md)

## Comments

Created from the 2026-09-22 scope audit and approved by the user. The audit
identified `lead-read`, `lead-read-go`, `lead-change`, `lead-implement`,
`lead-fixture`, `lead-plan`, `lead-triage` and `lead-wayfind` as the accidental
surface to reconcile, not as a predetermined list of files to delete blindly.
