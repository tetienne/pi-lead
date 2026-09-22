# 19: Contract the public surface and remove orphan paths

**What to build:** the installed package exposes only the Lead interaction
approved in Ticket 17, while provider adapters, Matt workflow selection,
fixtures and lifecycle stages remain private implementation or explicit
development tooling.

**Blocked by:** [18: Execute Matt workflows through one orchestrator](18-unified-orchestration.md)

**Status:** ready-for-agent

**Resolution:** DONE

## Acceptance criteria

- [x] Remove the provider-, skill- and stage-specific public commands replaced
  by the unified orchestrator; retain only `/lead <request>`. Cancellation uses
  native Pi interruption/session shutdown and status stays conversational.
- [x] Keep fixture and live-proof runners available as development scripts
  without registering them as product workflows.
- [x] Every shipped feature module is reachable from the Lead through the
  approved interface or explicitly identified as an internal adapter; delete or
  exclude orphan and deferred implementations from the release path.
- [x] Provider availability changes routing policy, not the command vocabulary;
  OpenCode Go and future providers can be added or removed without teaching the
  user a new interaction.
- [x] Preserve deterministic policy, worker isolation, credential confinement,
  review requirements, result correlation and cleanup while contracting the
  surface.
- [x] Update command-discovery tests, package contents and README examples so no
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

Implemented on 2026-09-22. The extension now registers only `/lead`; natural
requests and `/lead` use the same admission/orchestration path, and historical
command-shaped text receives no privileged parsing. The release archive uses an
explicit production allowlist whose contents are checked against the runtime
reachability graph, excluding deferred publication, provider-specific and
repository-only fixture entry points while retaining the latter as development
scripts. Production worker toolchain storage is cold and worker-private, and
successful review ends at a local reviewed commit.

Validation: native Pi RPC discovery from a fresh consuming project found only
`/lead` from this extension; the deterministic suite and typecheck passed; the
ChatGPT fake-provider and proposed-change development fixtures passed. The
isolated live-proof fixture produced correlated guest evidence for denied
egress, absent host credentials and a writable private workspace, but its
environment cleanup remained `CLEANUP_UNCONFIRMED`; its diagnostic tab and
artifacts were retained. This does not claim fresh live-runtime acceptance,
which remains owned by Ticket 20. Parallel standards and specification reviews
found no contract violation; their two maintainability observations were
resolved by simplifying provider-policy validation and making the production
toolchain state exactly `COLD`.
