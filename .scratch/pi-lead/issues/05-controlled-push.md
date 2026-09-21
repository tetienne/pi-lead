# 05: Push validated task branches through explicit policy

**What to build:** automatically push a validated task branch to the configured consuming-project remote, while gated actions remain concrete requests for human approval.

**Blocked by:** [04: Review, fix and commit a complete local coding task](04-review-fix-commit.md)

**Status:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Restrict destinations and refs; refuse force/protected/arbitrary pushes and preserve unrelated branches.
- [ ] Missing or ambiguous remotes produce a precise local result and blocked publication step; no silent remote/repository creation.
- [ ] PR creation, merges, deployment and privileged actions remain gated; approvals bind to the intended operation and relevant state.
- [ ] Record publication intent and observed outcome; report failed/uncertain pushes honestly and reconcile before retrying.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Use local disposable Git remotes before a real remote. Cover allowed task-branch push, denied protected/force/arbitrary destinations, missing/ambiguous remotes, stale approvals, failed and uncertain publication and preservation of unrelated refs.

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

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

Implemented 2026-09-21. The host-owned publication boundary accepts only the already-reviewed `pi-lead/task-<task-id>` branch and one explicitly configured `PI_LEAD_GIT_REMOTE` plus `PI_LEAD_GIT_REMOTE_URL`. It validates local and remote refs against the final commit, rejects missing or ambiguous configuration, protected/arbitrary branch names and existing different remote task branches, and has no force/refspec/remote-creation mode. Intent is journaled before dispatch and the observed commit/diagnostic outcome is journaled after reconciliation; failed or uncertain outcomes retain the local commit and return `BLOCKED / PUBLICATION_BLOCKED`. PRs, merges, deployments and privileged actions have no automatic route; their approval token binds the operation and exact branch revision.

Validation: focused disposable-remote publication tests (success, missing/ambiguous configuration, rejected push, protected/arbitrary refs and unrelated remote branch), state-bound human-gate token tests, task-lifecycle publication/uncertainty tests, `npm test`, `npm run typecheck`, `git diff --check`, and independent Standards/Spec review. No live remote, protected-branch provider policy, provider, host-architecture or security scenario is claimed by this slice.
