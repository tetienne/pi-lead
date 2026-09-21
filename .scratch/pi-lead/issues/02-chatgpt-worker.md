# 02: Complete a ChatGPT Pro read-only worker task

**What to build:** ask the Lead a bounded question about selected project inputs and receive a correlated answer from a visible, fully isolated Pi worker using ChatGPT Pro.

**Blocked by:** [01: Install a Lead and complete an isolated fixture task](01-isolated-fixture.md)

**Status:** ready-for-agent

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Implement the researched native placeholder/provider-overlay/host-refresh composition, starting with fake secrets and explicit SSE.
- [ ] Prove endpoint/header/redirect restrictions, absence of real tokens in guest-visible storage/output, and cancellation before accepting live work.
- [ ] Use native Pi lifecycle evidence plus assignment identity; do not treat screen idle or agent-settled alone as success.
- [ ] Plain chat spawns nothing; explicit bounded task admission and its escape hatch share policy. Jev is optional until its slice exists.
- [ ] Disable optional cache warming; quota/refresh/unavailable-model errors stop with a useful explanation, without paid fallback.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Start with synthetic credentials, then exercise real ChatGPT subscription streaming only when access is available. Cover exact endpoint/header/redirect policy, token confinement, refresh failure, model availability, continuation/settled semantics, quota exhaustion, chat without a worker and stop/cleanup.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Chatgpt Isolation](../../../docs/research/chatgpt-isolation.md)
- [Provider Access](../../../docs/research/provider-access.md)
- [Pi Contracts](../../../docs/research/pi-contracts.md)
- [Herdr Contracts](../../../docs/research/herdr-contracts.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.
