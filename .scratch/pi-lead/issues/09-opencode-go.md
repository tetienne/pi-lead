# 09: Use OpenCode Go when included quota is available

**What to build:** an allowed worker task can use Pi's native OpenCode Go provider and safely stop when included quota is exhausted.

**Blocked by:** [02: Complete a ChatGPT Pro read-only worker task](02-chatgpt-worker.md)

**Status:** ready-for-human

**Execution gate:** the user approved this plan and its ticket granularity. Application implementation remains paused until the user asks to begin. A ready status alone does not override that hold or unfinished blocking tickets.

## Acceptance criteria

- [ ] Reuse host-held credential substitution and preserve required native session/client headers.
- [ ] Verify provider streaming and model selection without introducing an OpenCode CLI or separate provider client.
- [ ] Establish the account's overage behavior before unattended use; no paid balance fallback is authorized.
- [ ] Fixtures cover exhaustion immediately; live acceptance waits for available included quota without blocking ChatGPT milestones.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Exercise native provider headers/model selection, credential confinement, streaming and quota/overage failures with fixtures. Live subscription acceptance must wait for included quota and must not spend paid balance as a workaround.

Run the required checks and an independent Standards/Spec review of this ticket's implementation before committing, even before PI Lead automates review itself. Report commands/results, any review corrections, the delivered revision, runtime evidence and explicit remaining limits. Use Matt implement/TDD; work one behavior at a time. No passing claim for an unrun host/provider/security scenario.

## Primary context

- [Approved standalone specification](../spec.md)
- [Domain glossary](../../../CONTEXT.md)
- [Isolation decision](../../../docs/adr/0001-isolate-first-real-worker.md)
- [Lifecycle ownership](../../../docs/adr/0002-own-worker-lifecycle-outside-herdr.md)
- [Bounded Jev policy](../../../docs/adr/0003-bound-jev-judgments-with-policy.md)
- [Durable task ownership](../../../docs/adr/0004-separate-task-records-from-conversations.md)
- [Matt workflow contracts](../../../docs/planning/matt-workflow.md)
- [Provider Access](../../../docs/research/provider-access.md)
- [Sandbox Boundary](../../../docs/research/sandbox-boundary.md)

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

2026-09-22: BLOCKED on the included-quota human gate. A live PI Lead OpenCode Go worker reached the provider using the operator's configured account and returned `429` with `GoUsageLimitError: Go usage limit exceeded`. It stopped as `BLOCKED`; no paid-balance fallback was used. This is live evidence of quota exhaustion, not the required successful streaming/model-selection acceptance. Do not retry until included quota returns and keep the account's **Use balance** option disabled.

Implementation completed 2026-09-21, pending the ticket's explicit live-account human gate. `lead-read-go` creates a bounded read-only worker using Pi's native `opencode-go` provider and its pinned `gpt-5.6-luna` catalog record; no OpenCode CLI or separate client was introduced. The host holds `OPENCODE_API_KEY`, substitutes only at `https://opencode.ai/zen/go/v1/responses`, preserves Pi's `x-opencode-session` and `x-opencode-client: pi` headers, denies redirects/alternate destinations and fails closed on reflected keys. Exhaustion is a terminal `QUOTA_EXHAUSTED` result with no paid-provider fallback.

Unattended execution requires the operator to first confirm that OpenCode Go's **Use balance** option is disabled, then set the local `PI_LEAD_OPENCODE_GO_NO_OVERAGE_CONFIRMED=1` acknowledgement. This is a human gate, not evidence that the account setting has been inspected. A real included-quota run remains pending and must not be substituted with paid balance.

Validation: `npm run typecheck`; `node --test test/opencode-go-policy.test.ts test/opencode-go-task.test.ts` (7/7); and `node src/run-opencode-go-fake-cli.ts`, which ran an isolated Gondolin VM through Pi's native streaming path, observed one mediated request with the selected provider/model and required headers, collected the correlated answer, and confirmed VM termination. The sandbox initially prevented Gondolin from opening its local virtio socket; the same fake-upstream fixture passed when run with the required local VM permission. The full suite previously passed before concurrent Ticket 10 work added an incomplete test file; it is not a Ticket 09 failure.
