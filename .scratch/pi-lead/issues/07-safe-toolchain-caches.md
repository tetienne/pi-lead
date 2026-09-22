# 07: Reuse safe toolchain caches across repeated tasks

**What to build:** repeated project tasks use mise-managed versions and read-only cache seeds with private writable storage, accompanied by measured startup improvements or an honest lack of improvement.

**Blocked by:** [03: Return a validated proposed change from a private workspace](03-validated-proposed-change.md)

**Status:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [x] Demonstrate cache reuse and malicious/cross-worker cache-write isolation using representative project dependencies.
- [x] Respect pinned versions and guest architecture/ABI; never mount the host mise home or reuse incompatible host binaries.
- [x] Compare cold preparation, warm readiness and execution timings on a repeatable task.
- [x] Limit cache work to demonstrated value; no automatic promotion of untrusted writable cache content.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Repeat the same task with cold and warm caches, then attempt cross-worker cache poisoning. Verify selected tool versions/architecture, read-only shared seeds and private writes; measure actual timings without asserting an unmeasured target.

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

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

2026-09-22 scope decision: cache optimization is deferred from the refocused
current release because the measured warm path did not improve. The private
writable-storage and no-shared-writable-cache invariants remain product core;
the seed-reuse implementation and measurements remain development evidence.

Implemented 2026-09-21. Proposed-change workers now key mise seeds by the committed `.mise.toml`, exact `mise=2025.8.20-r0`, verified Linux guest architecture and musl ABI. A seed is reusable only after a trusted host attests an integrity manifest; Gondolin mounts it read-only and copies it into worker-private mise storage. Worker content has no route to promote back into a seed.

Validation: focused policy/runtime tests, `npm test` (83 passing) and typecheck passed before subsequent Ticket 08 worktree changes; cold/warm Gondolin fixture runs persisted all preparation, readiness and validation timing deltas and reported `NO_IMPROVEMENT` when not every phase improved. The fixture also proved a guest cannot write the seed, that a private poison written by one worker is absent for the next worker sharing that seed, and that host checkout/VM cleanup remain correct. Independent Standards and Spec reviews drove the seed attestation, platform, pinning and measurement corrections. macOS arm64 is the only runtime evidence; Ubuntu 24.04 x86_64/arm64 remains Ticket 08 work.
