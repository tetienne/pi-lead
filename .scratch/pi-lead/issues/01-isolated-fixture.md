# 01: Install a Lead and complete an isolated fixture task

**What to build:** activate the package in a disposable consuming project, request a harmless fixture task, see it in a named background Herdr tab inside Gondolin, collect its result, and close it with a final summary.

**Blocked by:** None (first dependency-free ticket; execution still requires implementation authorization).

**Status:** DONE

**Execution gate:** the user approved this plan, its ticket granularity and implementation. Ticket 01 is complete.

## Acceptance criteria

- [x] Establish the smallest native package, thin Lead entry point, host lifecycle/policy seam and pinned runtime baseline needed for this path; no general framework scaffolding.
- [x] Preserve Lead focus; bind returned resource IDs to one assignment; reject stale/incorrect fixture results.
- [x] Default-denied guest network, bounded workspace, no host credentials/control sockets and actual VM termination are demonstrated before real worker use.
- [x] Failure/cancellation retains diagnostic visibility while stopping execution; controller/terminal loss has a bounded stop behavior, even though rich recovery comes later.
- [x] Native terminal/control incompatibility is a recorded feasibility blocker, not a reason to weaken isolation.

## Context and constraints

PI Lead is a reusable, per-project Pi package. The user stays in one Lead tab; important workers run their entire Pi process inside Gondolin and appear in named Herdr tabs without taking focus. Herdr is the human control plane, not a sandbox. Prefer native Pi/Herdr/Gondolin/mise/Git mechanisms over new frameworks; a concrete integration failure is a blocker, not permission to weaken the boundary.

The approved targets are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64. ChatGPT Pro is the initial provider; OpenCode Go was out of quota during planning. Workers use included subscription allowances with no paid fallback. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Real credentials and host control sockets remain outside guests; networking uses explicit allowlists and writable storage/caches are private.

Keep at most two workers active, including reviews, and no more than two review/fix cycles. Automatic validated local commits and task-branch pushes are allowed; PR creation, merges, deployment, privileged operations, protected/force pushes and new destinations are not automatically authorized. Preserve the user's active checkout and uncommitted changes.

DONE requires the scoped outcome, correlated collected artifacts, final-revision validation/review and confirmed cleanup. Failed/BLOCKED workers stop while diagnostic tabs/artifacts remain. Interrupted work requires confirmation before resuming. Successful logs last seven days; failed diagnostics remain until explicitly cleared. This slice may expose an unavailable capability or human gate, but cannot claim unfinished downstream behavior works.

## Validation and delivery

Test public task lifecycle and policy behavior at the approved seams; use controlled runtime substitutes and supplied judgments where appropriate, then real integrations for behavior that substitutes cannot prove. Demonstrate the native installation-to-summary path using a harmless fixture, including wrong/stale assignment identity, focus preservation, denied egress, cancellation, controller/terminal loss and observed VM termination. No model account is needed for this slice.

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

Read source version caveats before using an API; research is source evidence, not runtime acceptance. Bootstrap and consuming-project policy govern actual permissions. Request human-only setup only when it becomes necessary, never by asking for a secret in chat.

## Comments

Completed 2026-09-21 on macOS arm64 with Node 24.14.1, npm 11.11.0, Pi 0.86.1, Herdr 0.8.0 and Gondolin 0.12.0. A disposable consuming project installed the local package successfully, and Pi RPC command discovery found `lead-fixture` without a model or provider.

Final deterministic validation:

- `npm test`: 15/15 passing.
- `npm run typecheck`: passing.
- `npm pack --dry-run --cache /private/tmp/pi-lead-npm-cache`: passing; 12 intended package files, 38.6 kB unpacked.
- Package activation: `pi install -l /Users/Thibaut/git/pi-lead` succeeded in `/private/tmp/pi-lead-consumer.5hswhV`.

Native runtime evidence:

- Nominal task `a87aad30-83db-460f-b4d9-08916c1c379a`, VM `d53b894c-a8fb-4604-b8cf-2a5cf0354d5c`, tab `w34:tC`: `DONE`, denied egress observed, private workspace writable, host environment absent, VM termination confirmed, successful tab closed, Lead focus preserved on `w34:p3`.
- Launch-timeout task `56af3455-eb8e-4904-b856-efcd70f74611`: `BLOCKED/CONTROLLER_TIMEOUT`, diagnostic retained, VM terminated.
- Terminal-loss task `fdc951fe-1f30-4ffe-b792-ec99f7fdebc1`, VM `da62ac7c-f7e0-40b0-b969-47a0feced7ca`, tab `w34:tD`: `BLOCKED/RUNTIME_FAILURE`, VM terminated.
- Controller-loss artifacts under host state key `cf60e54e72765caf6e4d6da0456b381eaa16a81c0e9c7f086ceedf8e279ad037` record `exec aborted` and confirmed termination of VM `bd7af03e-528e-453c-9a2a-ddd891559e7b` after heartbeat expiry.

Two independent Standards/Spec review cycles completed. The first cycle drove corrections for PID-backed termination proof, launch-time cancellation/heartbeat coverage, the two-worker admission limit, recorded native launch blockers and missing real-runtime scenarios. The final cycle found no documented-standard violation; its non-blocking judgement calls were duplicated boundary parsing, repeated signal classification and primitive string IDs. The final Spec review passed with zero blockers after null PID handling was made fail-closed and launcher errors were added to the retained visible runtime log. Cleanup exceptions also now return `BLOCKED/CLEANUP_UNCONFIRMED` through the public lifecycle seam.

Limits remain explicit: runtime evidence is macOS arm64 only; Ubuntu 24.04 x86_64/arm64, a real guest Pi worker and ChatGPT authentication belong to later tickets. Ticket 06 owns seven-day successful-log expiry, recovery and explicit diagnostic clearing; Ticket 01 retains stopped failed diagnostics indefinitely in the interim. There is no configured Git remote, so this ticket delivers a local commit without a push. Failed diagnostic tabs, including `w34:t3` and `w34:t7`, remain intentionally available and were not cleared.
