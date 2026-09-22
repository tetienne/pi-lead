# 16: Verify reusable installation and the current release experience

**What to build:** a fresh consuming project can install a pinned package and complete the current macOS arm64/ChatGPT Pro end-to-end workflows with documented operating limits.

**Blocked by:** [07: Reuse safe toolchain caches across repeated tasks](07-safe-toolchain-caches.md); [11: Select allowed models and reasoning at worker spawn](11-model-reasoning-routing.md); [13: Diagnose bugs and review existing branches](13-debug-and-review.md); [14: Triage incoming work and resolve large design maps](14-triage-and-wayfinding.md); [15: Execute the dependency frontier with two workers](15-dependency-scheduler.md)

**Status:** ready-for-agent

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Exercise native install/activation, resource trust, pinning and upgrade behavior without leaking global configuration between projects.
- [ ] Run combined lifecycle, isolation, ChatGPT Pro provider, review, publication, routing-budget, scheduler and recovery scenarios against the final versions.
- [ ] Document measured startup and the explicit Ubuntu/OpenCode Go deferrals; publish only claims supported by actual acceptance evidence.
- [ ] Confirm summaries, retained artifacts, log expiry and no unnecessary active workers. Preserve local artifacts when publication awaits an existing human gate.
- [ ] Packaging is release-ready locally; external package publication or repository creation is not silently included.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The current release scope is macOS arm64 with ChatGPT Pro. Ubuntu 24.04 LTS x86_64/arm64 and a successful OpenCode Go worker remain deferred in Tickets 08 and 09; neither is a current-release compatibility claim. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Run final combined scenarios in fresh consuming projects on macOS arm64. Cover pinned installation/upgrade and resource trust, ChatGPT Pro, permission/escape boundaries, budget/review/scheduling/recovery behavior, truthful summaries and measured performance. Document, rather than imply coverage for, Ubuntu and OpenCode Go.

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
- [Sandbox Boundary](../../../docs/research/sandbox-boundary.md)
- [Chatgpt Isolation](../../../docs/research/chatgpt-isolation.md)
- [Provider Access](../../../docs/research/provider-access.md)
- [Jev Contracts](../../../docs/research/jev-contracts.md)
- [Workspace And Mise](../../../docs/research/workspace-and-mise.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

2026-09-22: The user explicitly approved bypassing Tickets 08 and 09 for this release. Ticket 16 now accepts only macOS arm64/ChatGPT Pro evidence. Ubuntu 24.04 x86_64/arm64 and a successful OpenCode Go worker remain deferred, with no compatibility or successful-provider claim; Ticket 08 and Ticket 09 remain BLOCKED rather than DONE.
