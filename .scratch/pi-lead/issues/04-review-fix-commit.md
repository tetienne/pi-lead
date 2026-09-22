# 04: Review, fix and commit a complete local coding task

**What to build:** a coding task produces independently reviewed, validated commits on a task branch and a summary of review corrections.

**Blocked by:** [03: Return a validated proposed change from a private workspace](03-validated-proposed-change.md)

**Status:** ready-for-human

**Resolution:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [x] Drive Matt implement/TDD at approved seams, with independent Standards and Spec reports and a pinned comparison/spec source.
- [x] Tie checks and reviews to the final changes; fixes invalidate affected evidence and trigger revalidation.
- [x] Permit no more than two review/fix cycles after the initial review; unresolved work becomes BLOCKED with diagnostics.
- [x] Run no more than two workers concurrently, including reviewer workers; queue excess work and retain separate review contexts.
- [x] Deliver and retain commits, collect evidence, verify teardown and clean successful tabs before reporting local task completion.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Use a task with a seeded defect that independent review detects, prove a correction cycle, and prove BLOCKED after the bound. Verify evidence matches the final revision, both review axes are independent, two-worker capacity is respected and delivered commits survive cleanup.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Pi Contracts](../../../docs/research/pi-contracts.md)
- [Herdr Contracts](../../../docs/research/herdr-contracts.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

Implemented 2026-09-21. `/lead-implement` takes the existing explicit base/check/dependency inputs plus a confined `--spec` path. The Lead snapshots that specification and the applicable repository/Matt workflow standards before work begins, records their digests in independent Standards and Spec reports, and reserves/queues two worker slots for the whole build/review lifecycle. Blocking reports cause a fresh isolated proposal with the same required checks; all review rounds are retained, and a third unresolved round returns `BLOCKED / REVIEW_LIMIT_REACHED`.

The final local delivery re-collects the exact reviewed proposal bundle, refuses an existing/arbitrary branch, and creates only `pi-lead/task-<task-id>` without changing the active checkout or publishing. Collected review context includes prior and proposed contents; oversized complete context blocks rather than attesting to a partial revision. The builder explicitly loads the pinned Matt `implement` and `tdd` skills; reviewer reports retain separate Pi/worker identities, cleanup evidence and artifacts. Durable cross-restart reconciliation and retention remain Ticket 06 work.

Validation: `npm test` (58 passing), `npm run typecheck`, `git diff --check`, focused local Git task-branch delivery test, correction-cycle/validation identity tests, and queued-capacity test. No live provider, host-architecture, or external-push claim is made by this slice.
