# 13: Diagnose bugs and review existing branches

**What to build:** “debug this” follows the native diagnosis loop and “review this branch” returns independent Standards/Spec findings without forcing an implementation workflow.

**Blocked by:** [04: Review, fix and commit a complete local coding task](04-review-fix-commit.md)

**Status:** IN PROGRESS

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [x] Build an executed symptom-specific failing feedback loop before diagnosing; preserve reproduction and verification evidence.
- [x] Route a fix through the existing validated/reviewed commit path and retry bounds.
- [x] Pin branch comparison and originating spec for standalone reviews; handle a missing spec explicitly.
- [x] Read-only review produces findings without creating unrelated changes or publishing them.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Reproduce a seeded bug with an executed failing feedback loop, fix it through the approved review/commit path, and separately review an existing branch. Verify missing spec handling and no unrelated modifications from read-only review.

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

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

2026-09-22 scope audit: the debug and standalone-review lifecycles satisfy
their controlled tests, but neither is called by the main Lead extension.
Consequently the promised natural-language requests are not available through
the product interface. Ticket 18 owns that integration; the checked criteria
above record the completed lifecycle implementation, not end-to-end admission.

Implemented 2026-09-21. `runDebugTask` requires attributable, executed failing feedback before diagnosis, carries the diagnosis into the existing `runReviewFixCommitTask` lifecycle, and accepts completion only after the same feedback loop passes. `runStandaloneBranchReview` resolves the named base and review branch through the trusted Git boundary, verifies supplied document digests, produces independent Standards/Spec reports when a spec exists, reports a missing spec explicitly, and confirms unchanged worktree/ref snapshots even after a reviewer fails. Fulfilled sibling review evidence is retained on failure.

Validation: `npm test` (121 passing), `npm run typecheck`, and `git diff --check`. Independent Standards and Spec reviews were run twice: the first identified review-evidence gaps; the corrected final diff had no findings on either axis. Delivered commits: `6042c55`, `7c3a160`, and `34c1e25`. No live provider, guest execution, or host-security scenario was claimed by these controlled lifecycle tests.
