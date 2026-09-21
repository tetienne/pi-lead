# 11: Select allowed models and reasoning at worker spawn

**What to build:** the Lead assigns bounded tasks to adequate permitted model/reasoning combinations and reports the actual selections and fallback decisions.

**Blocked by:** [10: Route natural-language intent through bounded Jev calls](10-jev-intent-routing.md)

**Status:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Use Jev only for semantic resource judgments; deterministic code handles context size, available providers, budget and concurrency.
- [ ] Map validated categories to configured native Pi models; verify actual selected model and effective/clamped reasoning.
- [ ] Test unavailable auth/model, stale judgments and quota loss; only an adequate preapproved fallback may proceed.
- [ ] Demonstrate multiple ChatGPT choices without making OpenCode quota a prerequisite; include Go automatically once its integration is available.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Supply resource judgments and native model capability fixtures, then verify actual model/thinking selection for representative tasks. Cover clamping, auth failure, quota loss, stale answers, unavailable adequate fallback and no out-of-catalog selection.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Jev Contracts](../../../docs/research/jev-contracts.md)
- [Pi Contracts](../../../docs/research/pi-contracts.md)
- [Provider Access](../../../docs/research/provider-access.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

Implemented the deterministic worker model/reasoning policy seam on 2026-09-21. It accepts only bounded semantic resource judgments, then independently admits configured native Pi provider/model/reasoning pairs using current catalog, authentication, quota, budget, confidence, context and a hard two-worker ceiling. A changed state or forged selection cannot be attested; the observed Pi model and effective/clamped thinking level are accepted only when they re-pass the same policy. Two configured ChatGPT choices are covered, and OpenCode Go enters automatically only when its native provider state makes it an adequate fallback.

Validation: focused routing-policy tests pass (11/11), the final full suite passed 114 tests, and `npm run typecheck` passed. No live provider or host integration was run for this policy-only slice. Independent Standards and Spec reviews led to budget, capacity, confidence, catalog, fallback, state-revalidation and duplication corrections. Ticket 10 is complete per the user, clearing this ticket's final dependency.
