# 08: Run the isolated task path on both Linux architectures

**What to build:** the same install → Lead → ChatGPT worker → result → cleanup scenario works on Ubuntu 24.04 LTS x86_64 and arm64, with evidence alongside macOS arm64.

**Blocked by:** [02: Complete a ChatGPT Pro read-only worker task](02-chatgpt-worker.md)

**Status:** wontfix

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Select compatible pinned guest assets/toolchains and preserve native Herdr tab/focus behavior.
- [ ] Repeat credential, mount/network and termination checks on the supported host families.
- [ ] Missing test hardware is an explicit acceptance blocker, not inferred compatibility from upstream support claims.
- [ ] Later behavior uses this host matrix; this ticket supplies a reusable scenario runner rather than claiming unbuilt features are tested.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Run the fixture and real ChatGPT task on macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64, including terminal focus, provider mediation and confinement/termination failures. Record exact versions and missing environments instead of marking unrun targets passed.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Sandbox Boundary](../../../docs/research/sandbox-boundary.md)
- [Herdr Contracts](../../../docs/research/herdr-contracts.md)
- [Chatgpt Isolation](../../../docs/research/chatgpt-isolation.md)
- [Workspace And Mise](../../../docs/research/workspace-and-mise.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

2026-09-22: BLOCKED. The required Ubuntu 24.04 LTS x86_64 and arm64 runtime environments are unavailable, and the user confirmed they cannot be verified. This ticket makes no compatibility claim from the reusable scenario runner, unit tests, upstream support, or the existing macOS evidence. The exact host/provider, confinement, termination, and no-focus artifacts remain required before it can resume.

The reusable host-matrix scenario runner was added in revision `11530fc` on 2026-09-21. It pins the approved Node/Pi/Gondolin/mise versions, requires Ubuntu 24.04 verification for Linux, and will report each of the toolchain, credential, confinement, termination, and no-focus Herdr checks as BLOCKED until its correlated artifact is collected and verified. It deliberately records unavailable target hardware as BLOCKED rather than inferring compatibility. Unit coverage (88 passing tests) and typechecking passed; no real provider/Herdr/VM scenario was run during this implementation, so macOS and both Ubuntu acceptance environments remain explicit runtime blockers.
