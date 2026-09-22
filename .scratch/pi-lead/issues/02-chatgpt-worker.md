# 02: Complete a ChatGPT Pro read-only worker task

**What to build:** ask the Lead a bounded question about selected project inputs and receive a correlated answer from a visible, fully isolated Pi worker using ChatGPT Pro.

**Blocked by:** [01: Install a Lead and complete an isolated fixture task](01-isolated-fixture.md)

**Status:** ready-for-human

**Resolution:** DONE

**Execution gate:** the user approved this plan and its ticket granularity, and authorized implementation on 2026-09-21. Ticket 01 is complete.

## Acceptance criteria

- [x] Implement the researched native placeholder/provider-overlay/host-refresh composition, starting with fake secrets and explicit SSE.
- [x] Prove endpoint/header/redirect restrictions, absence of real tokens in guest-visible storage/output, and cancellation before accepting live work.
- [x] Use native Pi lifecycle evidence plus assignment identity; do not treat screen idle or agent-settled alone as success.
- [x] Plain chat spawns nothing; explicit bounded task admission and its escape hatch share policy. Jev is optional until its slice exists.
- [x] Disable optional cache warming; quota/refresh/unavailable-model errors stop with a useful explanation, without paid fallback.

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

## Comments

Implementation and credential-free runtime proofs completed 2026-09-21 on macOS arm64 with Node 24.14.1, Pi 0.86.1 and Gondolin 0.12.0. The native worker stages the pinned Pi bundle into an unmounted VM, uses a synthetic JWT-shaped guest identity, refreshes the real OAuth credential only on the trusted host, and injects it only into the exact native SSE endpoint. Redirects, alternate paths/methods/query strings, unexpected credential placement and credential-bearing response headers fail closed. The host response stream retains a bounded tail and rejects a credential split across chunks before its bytes can reach the guest; guest output and bounded writable storage are independently scanned for every rotated host secret before a result is accepted.

Current validation:

- `npm test`: 33/33 passing after both independent-review correction cycles and the OAuth snapshot regression fix.
- `npm run typecheck`: passing.
- `npm run chatgpt-fixture`: one mediated native Pi SSE request through a Gondolin PTY, live native JSON events, correlated `agent_start`/assistant `message_end`/`agent_end` evidence, accepted fake answer and confirmed VM termination.
- `npm run chatgpt-cancel-fixture`: cancellation recorded before mediation, zero upstream requests and confirmed VM termination.
- `npm run chatgpt-reflection-fixture`: one mediated request deliberately reflected its injected bearer across response chunks; the host stream rejected it before those credential bytes reached Pi, guest-visible storage was audited, the result failed closed and VM termination was confirmed without putting the bearer/account ID in host artifacts.
- Native `openai-codex` authentication check: OAuth ready without printing credentials.

The first independent review found no documented-standard violation. It noted non-blocking duplication in the native Herdr controller, broad responsibilities in the first host runner and a repeated identity tuple; extracting a general framework now would expand this vertical slice. Its Spec axis drove the first correction cycle: the real Herdr pane now owns the launcher and receives live native Pi PTY events, explicit `--input`/`--inputs` selection safely embeds one to three bounded regular project files without a mount, reflected credentials have an adversarial integration proof, and concurrent refresh tests keep bearer/account pairs together. A final review remains required after the live proof.

The operator confirmed auto-recharge was disabled and that paid credits could not be consumed before the live proof. Current OpenAI documentation says available credits can continue usage after included limits, so this human check remains required before future live acceptance runs.

The first live attempt exposed a pinned-Pi integration bug: `ModelRuntime.getAuth()` could resolve OAuth while `isUsingSubscription()` remained false because `refreshOnCreate` had been disabled. A redacted deterministic probe reproduced `subscription:false` with OAuth available. The host credential source now refreshes Pi's local authentication snapshot at creation while keeping model-network access disabled, and a regression test covers that exact seam. A second attempt proved fail-closed handling of a server-rejected stale session (`REFRESH_FAILED`, native error events, diagnostic retained, VM terminated); direct native Pi produced the same rejection. After the operator reauthenticated, `pi auth check --provider openai-codex --json` reported ready OAuth.

Final real-provider evidence on macOS arm64:

- `npm run chatgpt-live`: `DONE` for task `9dcce90e-ed90-4742-b722-dd047613477c`, assignment `ee136ae0-1fb4-4f4e-8b4d-819be09ea9f7`, worker `07381550-dc7d-41a0-a488-86829f3c8a08`, Pi session `dec4da1e-0108-4ac4-9f0b-108ed1fe0d53` and VM `8c5bec64-67fa-4604-86ff-7ed1c52edb12`.
- The isolated worker answered from the explicitly selected `CONTEXT.md`: “Lead means the user's persistent point of interaction and the coordinator of an engineering task.”
- Artifact `837c2dc5a347ec2abc217159db66a63c01f4b952282c5f2882679a355aa6462c` was collected, VM termination was confirmed and successful Herdr tab `w34:tH` was closed.
- No API-key or paid-provider fallback was configured or attempted.

The second independent Standards review again found no documented-standard violations and retained the same three non-blocking deepening opportunities. Its Spec review caught that the first reflection proof withheld the bearer from Herdr/artifacts only after Pi had consumed the hostile body. The second correction cycle added a chunk-boundary-safe host response guard plus compressed-response rejection, then reran the hostile, benign fake-SSE and real subscription fixtures. Focused verification of the corrected final revision found no remaining Standards or Spec blocker. The final real-provider revision passed for task `8ab80768-4043-4bfe-a249-db76998c1882`, Pi session `e2105378-1bf0-4546-b9d2-7174db5c81b9`, artifact `0720efd9f6f8d7a94f3c4397b231ea7d3111d081890ad04e83d472baf88c1b00` and VM `fd5fb752-baee-4b89-8014-e4c8ebfe66d1`; termination was confirmed and successful tab `w34:tJ` closed. Linux architecture coverage remains assigned to Ticket 08, and richer recovery/retention remains assigned to Ticket 06.
