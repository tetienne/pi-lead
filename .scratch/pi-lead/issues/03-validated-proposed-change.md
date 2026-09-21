# 03: Return a validated proposed change from a private workspace

**What to build:** request a small edit; the worker uses a private project copy and mise toolchain, runs the required checks inside isolation, and returns a proposed change with validation evidence for review.

**Blocked by:** [02: Complete a ChatGPT Pro read-only worker task](02-chatgpt-worker.md)

**Status:** DONE

**Execution gate:** the user approved this plan and its ticket granularity, and authorized implementation on 2026-09-21. Ticket 02 is complete.

## Acceptance criteria

- [x] Transfer a named committed base using native Git primitives and private guest metadata; preserve the active checkout and local edits.
- [x] Correctly collect changed/new/deleted files, binary content, modes, renames and symlinks with path confinement.
- [x] Dependency access is explicitly allowed; denied destinations do not trigger automatic network expansion.
- [x] This slice ends at a review-required human gate: it does not call code changes DONE or publish/commit them automatically before the review capability exists.
- [x] Host collection does not execute guest-provided commands, hooks, filters or configuration.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Use a fixture repository with local edits, binary/renamed/deleted files, modes and symlinks. Exercise the edit-to-validation-to-review-required result, denied dependencies and attempts to escape the workspace or execute host hooks/filters.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Workspace And Mise](../../../docs/research/workspace-and-mise.md)
- [Sandbox Boundary](../../../docs/research/sandbox-boundary.md)
- [Pi Contracts](../../../docs/research/pi-contracts.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

Implementation and credential-free runtime proofs completed 2026-09-21 on macOS arm64 with Node 24.14.1, Pi 0.86.1 and Gondolin 0.12.0. `/lead-change` requires a short branch/tag name, one or more mise task names and an explicit list of dependency hosts. The Lead bundles the committed base outside the active checkout; the guest receives it in an unmounted private workspace, installs pinned Git 2.52.0 and mise 2025.8.20 only through allowed destinations, creates a proposal object, validates that exact object and returns a correlated bundle. The host inspects it in a fresh bare repository using `/usr/bin/git` with inherited/global/system configuration, hooks, filters, external diffs and submodule recursion disabled. Collection is bounded and preserves raw file bytes, modes, renames, deletions and transitively confined symlinks.

Current validation:

- `npm test`: 50/50 passing.
- `npm run typecheck`: passing.
- `npm run change-fixture`: `REVIEW_REQUIRED`, `mise run test` passed against proposal `cdd90f4598f043b01a54383d98bcd6c9f91df633`, one exact modified-file artifact collected, no host commit/publication, active checkout preserved and VM termination confirmed.
- `npm run change-denied-fixture`: `BLOCKED / DEPENDENCY_DESTINATION_DENIED` for undeclared `dl-cdn.alpinelinux.org`, empty dependency allowlist remained unchanged, checkout preserved and VM termination confirmed.
- `npm run change-mutating-check-fixture`: `BLOCKED / VALIDATION_FAILED` when the otherwise successful mise task changed tracked proposal content; diagnostics retained, checkout preserved and VM termination confirmed.

The first independent Standards review identified durable recovery/retention as not yet implemented and noted non-blocking duplication in native controllers/host runners. Recovery, seven-day retention and a unified durable task record remain explicitly assigned to Ticket 06; extracting a general worker framework would expand this vertical slice. The first Spec review found three blockers, all corrected in its review/fix cycle: checks now run after packaging and reset to the exact proposed commit, a denied dependency is exercised through the public lifecycle with its precise reason, and symlink confinement follows base and proposed symlink chains while rejecting cycles and transitive escapes.

The second independent Standards review found no blocker: Ticket 03 conforms to the isolation, lifecycle and review-gate decisions, while recovery and the unified durable task record remain correctly deferred to Ticket 06. The second Spec review confirmed the exact-proposal validation and transitive-symlink fixes, then found one race in denied-destination reporting: later allowed traffic could erase an earlier denial. The correction latches the first policy rejection without changing later access decisions; a focused regression test, the native denial fixture and targeted re-review all pass with no remaining blocker.

The credential-free fixture runs a controlled worker process inside the actual VM, while the real Pi/provider composition reuses the separately proven Ticket 02 path and was not charged again. Linux x86_64/arm64 runtime coverage remains assigned to Ticket 08. Ticket 04 owns human review, correction and host commit; this slice deliberately stops at `REVIEW_REQUIRED`.
