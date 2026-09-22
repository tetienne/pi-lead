# 14: Triage incoming work and resolve large design maps

**What to build:** requests to triage incoming issues or map a large uncertain effort follow Matt's native local-tracker workflows and lead into the approved spec/ticket path.

**Blocked by:** [12: Turn an idea into approved specs and vertical tickets](12-idea-to-tickets.md)

**Status:** DONE

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [x] Verify incoming claims, retain the canonical triage roles and write durable agent-ready briefs; do not retriage generated ready tickets.
- [x] Create decision maps with blocking edges, distinguish research from human decisions, and resolve decisions before build tickets.
- [x] Preserve human decisions and claims across sessions; a planning map does not authorize implementation.
- [x] Handoff and human-only wizard procedures are used when their contracts apply; no external account action is assumed.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Use local incoming requests and a multi-session decision map. Verify claim evaluation, triage transitions, no retriage for generated ready tickets, human decision gates, durable dependency state and handoff into spec rather than implementation.

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

Implemented the installed Matt triage and wayfinding entry points through `lead-triage` and `lead-wayfind`, plus natural-language routing. Both command and natural-language explicit workflow paths use the same intent-policy entry point. Explicit IDEATE, TRIAGE, and WAYFIND remain available when Jev is absent or misconfigured; natural-language classification still fails closed when Jev is unavailable.

Validation on the final revision `483e79f`:

- `npm run typecheck` passed.
- `npm test` passed: 127 tests.
- `git diff --check 20ab69811297aa7085ae2ca6b8112ecfaaa4bb05...HEAD` passed.

Independent review used `git diff 20ab69811297aa7085ae2ca6b8112ecfaaa4bb05...HEAD`. Standards found no documented violation; it noted only an optional duplicated-code observation in the three small workflow-start helpers. Spec review found and verified corrections for explicit command policy routing and explicit fallback when Jev is misconfigured. The correction revisions are `e0a9078` and `483e79f`.

Runtime evidence is the controlled Pi extension seam: tests prove bounded, escaped prompt construction; dispatch to the installed skills; no worker build start; and explicit fallback policy. No live Pi/Matt session created a real incoming triage record or persisted multi-session wayfinding map, and no handoff, wizard, or external account action was executed. Those installed-skill and human-gate behaviors remain deliberately unclaimed until exercised in a consuming project.
