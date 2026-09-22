# PI Lead: isolated, visible engineering workers

Status: ready-for-agent
Approval: approved by the user, including test seams and architectural decisions. Ticket granularity review precedes repository initialization and implementation.

## Problem Statement

The user wants to stay in one Lead tab and request engineering work in natural language without manually selecting skills, opening worker terminals, choosing every model, tracking subprocesses, or collecting results. Autonomous workers must not gain access to host credentials or unrestricted host execution. The solution must be reusable across consuming projects without introducing a second engineering workflow or a large orchestration framework.

## Solution

Provide a pinned Pi package activated explicitly in each consuming project. A thin Lead extension selects and follows the official Matt engineering workflows. A trusted host controller enforces deterministic policy and owns isolated workers, their Herdr tabs, results and cleanup. Each real worker runs its entire Pi process inside a Gondolin VM; Herdr provides human visibility and terminal control, not isolation.

Start with ChatGPT Pro because the user currently has available quota there and reports OpenCode Go exhausted. Support OpenCode Go when its included quota returns. Add Jev through OpenRouter for bounded intent and resource judgments, with a maximum of $1/day and an objective of substantially lower actual spend. Routine control uses native Pi, Herdr, Gondolin, mise, Git and TypeSafe primitives.

The completed experience is: natural-language request → appropriate workflow → only necessary visible workers → validated and independently reviewed result → collection and cleanup → final summary with branch/commit/push information and no unnecessary active workers.

## Release-scope amendment — 2026-09-22

The user authorized the current release to bypass Ticket 08 (Ubuntu 24.04 x86_64/arm64 acceptance) and Ticket 09 (a successful OpenCode Go run). Current-release acceptance therefore covers macOS arm64 and ChatGPT Pro only. The broader host/provider goals remain deferred roadmap work: Tickets 08 and 09 stay BLOCKED, are not treated as DONE, and this release makes no Ubuntu compatibility or successful OpenCode Go claim.

## User Stories

1. As a user, I want to activate PI Lead per consuming project, so that unrelated projects remain unaffected.
2. As a user, I want pinned versions, so that upgrades are deliberate and reproducible.
3. As a user, I want support for macOS arm64 and Ubuntu 24.04 LTS on x86_64 and arm64, so that I can work on both host families.
4. As a user, I want mise to manage project toolchains, so that workers use the project's required versions.
5. As a user, I want one persistent Lead tab, so that I keep a stable point of interaction.
6. As a user, I want natural-language requests without mandatory task commands, so that conversation remains ordinary.
7. As a user, I want an explicit workflow escape hatch, so that I can correct uncertain routing.
8. As a user, I want conversational replies without unnecessary workers, so that ordinary discussion stays cheap and quick.
9. As a user, I want clarification for consequential ambiguity, so that workers do not implement guesses.
10. As a user, I want Matt's actual skill contracts followed, so that PI Lead does not invent a competing development process.
11. As a user, I want research grounded in primary sources, so that native solutions replace unnecessary abstractions.
12. As a user, I want new designs recorded as context, decisions and standalone specs, so that fresh agents can continue.
13. As a user, I want vertical tickets with blocking edges, so that parallel work follows real dependencies.
14. As a user, I want approval of specifications and ticket granularity, so that implementation scope remains deliberate.
15. As a user, I want debugging to begin with a reproducible symptom, so that fixes address the reported problem.
16. As a user, I want an independent Standards and Spec review for code changes, so that success is not self-assessed only by the author.
17. As a user, I want each important worker in a named Herdr tab, so that progress is inspectable.
18. As a user, I want worker creation to preserve Lead focus, so that background work does not interrupt conversation.
19. As a user, I want at most two workers executing concurrently, so that resource use stays bounded.
20. As a user, I want a result associated with its exact assignment and final changes, so that stale output cannot satisfy a new task.
21. As a user, I want the first real worker isolated, so that an early milestone does not expose the host.
22. As a user, I want credentials retained on the trusted host, so that arbitrary worker code cannot read them.
23. As a user, I want explicit network allowlists, so that workers reach only approved destinations.
24. As a user, I want broader research access handled separately, so that dependency access does not imply unrestricted browsing.
25. As a user, I want worker-private writable storage and caches, so that one worker cannot poison another's environment.
26. As a user, I want my existing checkout and uncommitted changes preserved, so that autonomous work does not overwrite my work.
27. As a user, I want automatic task branches, validated commits and task-branch pushes, so that routine Git operations need little attention.
28. As a user, I want explicit approval for PR creation, merges, deployment and privileged actions, so that publication and elevated effects remain controlled.
29. As a user, I want ChatGPT Pro usable for the first isolated worker, so that exhausted OpenCode Go quota does not block the initial path.
30. As a user, I want worker usage to stay within subscriptions, so that exhaustion does not silently trigger paid fallback.
31. As a user, I want Jev restricted to permitted choices, so that model judgment cannot grant authority.
32. As a user, I want Jev's cost visible and capped at $1/day, so that inexpensive routing does not become uncontrolled spending.
33. As a user, I want adequate approved fallbacks when routing is unavailable, so that a service outage cannot bypass policy.
34. As a user, I want transport retries separated from review/fix cycles, so that retries cannot multiply without a bound.
35. As a user, I want no more than two review/fix cycles, so that unresolved defects return to me with evidence.
36. As a user, I want cancellation to stop real worker execution, so that a timeout or closed tab does not leave hidden work running.
37. As a user, I want results collected before successful tabs close, so that cleanup does not destroy the deliverable.
38. As a user, I want failed workers stopped with diagnostic tabs and artifacts retained, so that I can investigate without continued autonomous execution.
39. As a user, I want restart reconciliation and confirmation before resumption, so that crashes do not duplicate work or unexpectedly restart it.
40. As a user, I want successful-run logs retained for seven days and failed diagnostics until cleared, so that retention is predictable.
41. As a user, I want cold preparation and warm startup measured separately, so that optimization responds to actual costs.
42. As a user, I want a final summary of changes, checks, review corrections, branch/commit/push status and cleanup, so that completion is verifiable.

## Implementation Decisions

### Scope and distribution

Use a single reusable distribution with internal modules rather than a monolithic extension. Prefer native pinned project-local Pi package installation; no bespoke installer, provider framework, layout manager, distributed scheduler or permanent daemon in the initial design. Project activation includes an explicit allowlist of trusted package resources. Repository-controlled extensions and configuration must not become trusted host code merely because they are present.

The source baseline is installed Pi 0.86.1, Herdr 0.8.0, and mise 2026.9.1. Gondolin source was inspected at revision 29fa74d802112f29c720990aced26165e0d57d84; its package manifest says 0.12.0, but an installable release has not yet been selected. Pin verified compatible releases during implementation; do not substitute newer APIs silently. QEMU is the initial Gondolin backend candidate. Broader macOS/Linux support remains a deferred acceptance obligation, not a claim that current integrations have run successfully.

### Intake and workflow

Use native Pi input interception for conversational admission and before-agent behavior for workflow context. Both natural language and an explicit escape hatch invoke the same policy/lifecycle entry point. Track input origin and queued steering/follow-up to prevent recursive admission or duplicate task creation. Hook exceptions cannot enforce security: Pi may log them and continue.

Preserve Matt's main flow of interview, targeted research, standalone spec, vertical tickets and per-ticket implementation with review. Use diagnosing-bugs, review, triage and wayfinder when their contracts fit. Domain-modeling, codebase-design and writing-for-agents are cross-cutting disciplines, not mandatory states. Do not retriage tickets already produced ready for implementation.

The initial semantic intent catalogue is CHAT, IMPLEMENT, IDEATE, DEBUG, REVIEW, RESEARCH, TRIAGE, WAYFIND and OPERATE, with an explicit uncertain/no-match outcome. Mixed requests and consequential ambiguity return to clarification rather than speculative execution. A routing label never authorizes privileged activity.

### Policy and resource routing

Policy is deterministic and independently testable. It owns allowed providers/models/reasoning levels, concurrency, retry bounds, network destinations, filesystem grants, Git destinations, budget admission, approval requirements and completion conditions. Model selection uses Pi's native model/thinking controls; verify actual effective selection and treat unavailable approved choices explicitly.

Jev supplies bounded categorical judgments over task intent, difficulty and context needs. The host constructs permitted candidates before a request, validates returned structure/IDs/values/evidence afterward, and rechecks state freshness before acting. Map valid categories to configured allowed model/reasoning pairs. Missing confidence where required, an unknown choice or stale judgment cannot become a command or permission. Calibrate thresholds on representative cases rather than copying a documentation example.

Prefer the official TypeSafe SDK and OpenRouter's native System One route, subject to compatibility validation. Use a dedicated capped key for Jev only. The approved ceiling is $1 per daily reset period, aligned with the provider-side limit; expose the reset semantics during configuration. Include calls, retries and uncertain in-flight usage in admission. Reserve conservatively before concurrent requests and reconcile returned usage; exhausted or unknown budget blocks further paid routing rather than assuming zero cost. Provider limits complement local bounds; no exact financial guarantee is claimed until enforcement is validated. Keep prompts small, batch independent judgments when appropriate and avoid repeating unchanged judgments. Never manufacture calls to consume the allowance.

When semantic routing fails, explicit valid workflow selection remains available. For resource uncertainty, use a preapproved adequate default only if it satisfies current policy; otherwise return BLOCKED. No automatic paid provider substitution. Transport attempts have one finite total deadline and bounded count, including retries inside the SDK; they are distinct from the two review/fix cycles.

### Isolation, credentials and toolchains

Run the entire worker Pi process, extensions, shell children, dependency installation and project validation inside the VM. Host credentials, SSH agents, privileged sockets, Herdr control sockets and writable global caches are not mounted. The trusted host controller exposes only bounded worker-specific operations; worker messages and returned artifacts are untrusted data.

Set an explicit network allowlist; Gondolin's omitted allowlist permits all hosts. Keep global egress restrictions separate from credential destination restrictions. Use exact approved destinations and credential-bearing routes, retaining internal-address restrictions and avoiding broad forwarding exceptions. A denied dependency fetch reports the required destination rather than widening policy automatically.

Real access and refresh tokens stay on the host. ChatGPT Pro is first; its native Pi adapter parses token claims before sending a request, so a generic opaque credential placeholder is insufficient. Source research supports a native candidate: a unique synthetic JWT-shaped guest placeholder containing only the needed account metadata; an explicit native provider credential overlay retaining Pi's Codex subscription adapter; host-native OAuth refresh; and Gondolin's existing secret manager to rotate the real host value while the guest placeholder stays stable. A bare command-line key override alone does not enable this OAuth-only provider. This configuration does not switch to the OpenAI Platform API or its billing path.

Restrict credential-bearing requests to the exact approved HTTPS endpoint, method and headers, including redirects; a hostname allowlist alone is insufficient. Use explicit SSE and disable guest WebSocket upgrades for the initial provider integration so each request remains mediated. Synchronize host refresh and account selection across workers, stop on revoked/failed credentials, and test that the secret cannot be reflected into guest-visible output. These are source-supported candidate decisions with mandatory runtime proof before accepting a real worker. Copying the host auth file or giving the guest a real token is not a fallback. OpenCode Go remains supported but is not required to be currently available for the first milestone.

Use subscription authentication for worker providers, with no authorization for extra billed usage. Subscription sign-in alone does not prove that purchased credits cannot be consumed; verify applicable account settings and quota behavior before unattended operation. Stop or offer an already-approved provider with available included quota on exhaustion. Disable optional Pi cache warming initially; account for compaction and summarization/transport retries.

Use mise for guest tool versions and native package managers for dependencies. Host mise availability does not make macOS binaries usable in a Linux guest. Trusted read-only cache seeds may be shared; writable caches are private per worker. Build/install steps must remain subject to VM and network policy. Defer cache promotion and more elaborate reuse until measurements justify them.

### Herdr visibility and worker communication

Reuse the consuming project's Herdr workspace and create one semantic worker tab without taking focus. Store returned IDs rather than using sidebar positions or whichever pane is currently focused. A host wrapper can use native Pi identity hints and custom status reporting; do not expose the Herdr socket to the guest or shadow the Pi executable to trick agent-start.

Use native Gondolin PTY attachment for visibility. Pi RPC is headless, so combining visible native Pi interaction with machine-readable assignment/result evidence remains a required integration proof. Prefer native Pi events/session entries and a narrow host-owned channel over a second terminal protocol. Limit each worker to one outstanding assignment. Bind every event/result to task, attempt, worker, VM and Pi session identity; stale, oversized or misrouted messages cannot advance the task.

Herdr idle/done and Pi agent-settled are observations, not project DONE. Herdr screen reads may omit output or match an earlier turn. Completion must use assignment-specific artifacts and verification. Do not register guest sessions in Herdr's official host-Pi restore path; custom reporting avoids accidentally restarting guest work on the host.

### Workspace and Git ownership

The trusted controller owns task branches and integration. The default input is a named committed base; ask only when the requested task needs uncommitted changes included. Preserve the user's active checkout. Guest Git metadata is private, because linked worktrees share repository administration and refs. Use native Git transfer primitives with bounded file/path handling; do not invent a repository format.

Validate the collected changes, including binary files, modes, renames and symlinks, against the exact base and resulting revision. Host collection/integration must not execute repository-provided hooks, filters, configuration or shell strings. Project tests execute inside isolation. A changed final revision invalidates earlier review/check evidence that no longer covers it.

Automatic local task branches, validated commits and pushes to the configured consuming-project remote's task branch are allowed. This excludes force pushes, protected branches, arbitrary destinations and history rewriting. PR creation, main-branch merges, deployment and privileged operations require explicit approval. If the remote is absent or ambiguous, retain local work and report the publication requirement; do not create or choose a remote silently.

### Lifecycle and persistence

Use a small host-owned task record for policy and resource ownership while retaining native Pi sessions for conversation history and Herdr for presentation. Propose one durable record per task with atomic replacement, a single writer/lock per consuming project, a schema version, base/final revisions, worker/resource IDs, attempts, approvals, verification evidence and artifact locations. Keep authoritative policy/state outside guest-writable project content. Herdr metadata and event streams are nondurable and cannot be the task database.

Record intended external actions before dispatch and their observed outcomes afterward. After interruption, reconcile real resources before deciding whether to retry; never automatically replay a possibly accepted prompt or publication. A process or event gap is not success. Resume interrupted work only after user confirmation.

| State | Meaning and permitted progress |
| --- | --- |
| INTAKE | Record request and determine whether chat, clarification or a tracked workflow is needed. |
| DISCOVER / DEBUG / PLAN | Follow the applicable Matt process; collect facts or resolve decisions. |
| READY | Scope, approvals, dependencies and required resources permit execution. |
| BUILD | Execute bounded work; no more than two workers concurrently. |
| VERIFY | Check final artifacts, required validations and independent review. |
| FIX | Apply review corrections, then return to VERIFY; maximum two correction cycles after initial review. |
| DONE | All success evidence and required collection/cleanup conditions hold. |
| BLOCKED | Human input, unavailable required resources, exhausted retries/budget, cancellation or uncertain cleanup prevents progress; retain diagnostics and reason. |

Chat without work need not allocate a task/worker. Verification failures lead to FIX only while within the bound; otherwise BLOCKED. A canceled task is recorded as BLOCKED with a cancellation reason and no automatic restart. Status reason preserves the distinction from failure or waiting for approval without expanding the initial state machine.

DONE requires: the requested outcome is evidenced; required checks and independent review pass for the final revision; correction cycles are resolved; artifacts and transcripts are durably collected; permitted commits/pushes are recorded or an explicitly scoped publication step is left awaiting approval; worker execution and VM teardown are confirmed; owned temporary tabs/resources are cleaned; and the final summary contains validation, review, Git and cleanup results. Required cleanup failure prevents DONE. Do not claim a requested push succeeded when it did not.

On failure or BLOCKED, stop autonomous worker execution and preserve its diagnostic tab, transcript and artifacts. Cancellation must reach actual processes/VMs; rejecting a local promise does not prove guest termination. Abrupt tab closure, host-wrapper failure and Lead restart require reconciliation. Successful logs expire after seven days; failed diagnostics remain until explicitly cleared. Retention never requires keeping a VM alive, and successful cleanup never deletes the delivered branch or commits.

## Testing Decisions

The proposed public seams are task lifecycle and policy decisions. User review of this specification confirms these seams before tests are written. There is no existing application test suite or repository prior art.

Test behavior rather than private collaborators: a request produces an attributable result or a precise BLOCKED outcome, with required checks and real cleanup; policy admits only authorized actions/resources. Use controlled runtime substitutes for deterministic lifecycle failures and supplied judgments for policy tests, avoiding paid inference in ordinary tests. TDD proceeds one behavior at a time at these seams.

Required cases include duplicate admission, steering versus a new task, stale/forged completion, wrong worker identity, quota exhaustion, missing model, uncertain budget, Jev malformed/no-match/stale responses, bounded retries, review corrections, failed result collection, cleanup failure, tab closure, crashed controller, reconnection and human-confirmed recovery. Verify that approval is tied to the intended action and cannot be broadened by a worker or judgment.

Real integration acceptance covers: ChatGPT Pro streaming/authentication and host-only real tokens; Herdr tabs/input/resize/status without focus theft; Pi continuation/settled semantics; default-denied egress; mount/symlink/path confinement; absence of host credentials/control sockets; cache isolation; cancellation and orphan termination; exact Git changes and protected destinations; and all supported host/architecture combinations. Test a harmless fixture first, then a small real worker task. Escape/permission tests provide scoped evidence, not a claim of universal hypervisor security.

Use representative routing examples to evaluate Jev's usefulness and thresholds separately from deterministic tests. Live paid tests require configured bounded credentials and are not part of this planning phase. Measure image/download preparation, warm VM readiness, Pi readiness, assignment completion and cleanup separately from the first slice; report timings and environment rather than inventing an unmeasured latency promise.

## Out of Scope

- Implementation, runtime prototypes, live inference calls, credential setup and Git initialization during this specification review.
- Remote worker execution, advanced budget optimization, distributed scheduling, permanent control-plane services and multi-user authorization.
- A new provider SDK, terminal framework, generic workflow engine or custom installer where native primitives suffice.
- Community extensions in the critical path without exceptional documented justification.
- Unrestricted guest networking, host-secret mounts, shared writable global caches or model-granted privilege.
- Automatic PR creation, protected-branch publication, merges, deployment, force pushes or automatic resumption after interruption.
- Promising compatibility or security tests that have not been run, or a fixed startup target without measurements.

## Further Notes

This specification is self-contained for scope and acceptance, but linked research retains exact source signatures and version caveats: [Pi contracts](../../docs/research/pi-contracts.md), [Herdr contracts](../../docs/research/herdr-contracts.md), [Gondolin boundary](../../docs/research/sandbox-boundary.md), [provider access](../../docs/research/provider-access.md), [ChatGPT isolation](../../docs/research/chatgpt-isolation.md), [Jev contracts](../../docs/research/jev-contracts.md), [workspace and mise](../../docs/research/workspace-and-mise.md), and [Matt workflow contracts](../../docs/planning/matt-workflow.md).

Feasibility gates for early vertical slices are credential mediation for ChatGPT Pro, visible guest Pi with machine-readable result correlation, private workspace transfer, and confirmed cleanup/recovery. Source research identifies candidate primitives; only later authorized integration tests can close these gates. Failure must produce a specific blocked finding rather than silently weaken isolation or substitute a paid provider.

After spec approval, use to-tickets to propose complete vertical slices and their blocking edges, obtain granularity approval, and only then initialize the local repository at the bootstrap's repository phase. No GitHub setup, secret sharing or other manual account action is needed to review this document.
