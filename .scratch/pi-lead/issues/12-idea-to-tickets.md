# 12: Turn an idea into approved specs and vertical tickets

**What to build:** a natural-language planning request runs Ask Matt and grill-with-docs, delegates source research when useful, and produces context/ADRs, a standalone spec and separate dependent tickets after the appropriate reviews.

**Blocked by:** [02: Complete a ChatGPT Pro read-only worker task](02-chatgpt-worker.md)

**Status:** ready-for-human

**Resolution:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [x] Reuse official skills/resources and their actual contracts; do not manufacture one machine state per skill.
- [x] Preserve resolved decisions, primary-source references and human checkpoints; ask decisions rather than facts the worker can research.
- [x] Keep broader research network access explicit and separate from ordinary dependency/provider access.
- [x] Local tracker output supports fresh implementation contexts; ticket granularity review precedes ticket publication.
- [x] Wayfinder remains an explicit unavailable detour until its dedicated slice exists.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Walk a sample idea through interview, primary-source research, glossary/ADR updates, spec review and ticket granularity approval. Verify durable standalone artifacts, distinct blocking edges, preservation of decisions and no build authorization inferred from planning output.

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
- [Sandbox Boundary](../../../docs/research/sandbox-boundary.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

`lead-plan` and natural IDEATE routing now dispatch the installed Ask Matt flow through Pi skill expansion. The bounded prompt requires grill-with-docs, explicitly gated primary-source research, to-spec, human seam approval, to-tickets, human ticket-granularity approval, and separate local tracker publication. Wayfinder is explicitly unavailable. The former local pseudo-skill state machine was removed.

Automated validation passed through the full suite before the final prompt-boundary correction. The live integration test then loaded `lead-plan` from the project-local extension, entered `ask-matt`, `grill-with-docs`, explicit primary-source research, received the two human confirmations, and reached `to-spec`. The user explicitly accepted this as the ticket test and intentionally interrupted it before it created a sample spec or tickets; no business artifacts or approvals were fabricated. The integration is therefore accepted as DONE, while a future real planning request will produce its own artifacts through the same human gates.
