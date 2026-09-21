# Bootstrap interview decisions

Source: [bootstrap brief](../../PI_LEAD_BOOTSTRAP.md) and the user's first interview answers. This is a planning record, not an approved specification or authorization to implement.

## Agreed

- Support macOS arm64 and Ubuntu 24.04 LTS on x86_64 and arm64. Use mise for project toolchains; compatibility and runtime validation remain research/acceptance work.
- Isolate the first real autonomous worker. Any preceding lifecycle demonstration uses a harmless fixture.
- Track this project's specification and tickets in local Markdown using the Matt workflow. Initialize Git only at the bootstrap's repository phase, after approval.
- Worker providers: ChatGPT Pro and OpenCode Go. ChatGPT Pro is the first-worker provider because the user reports OpenCode Go currently exhausted. Prefer included subscription usage and stop at exhausted allowances; no paid fallback is authorized. Jev uses OpenRouter with a $1/day ceiling, not a spending target; minimize bounded routing requests.
- Worker network access uses an allowlist for approved model endpoints and dependency registries; broader research access is separate.
- Permit automatic isolated branches/worktrees, validated local commits, and pushes to PI Lead's own task branches. Require approval for PR creation, merges, deployment, and privileged operations. Force pushes, protected-branch pushes and arbitrary destinations are not authorized by this task-branch permission.
- Initial limit: two concurrent workers and two review/fix cycles. Precise handling of exhausted retries and cancellation belongs in the specification.
- Retain successful-run logs for seven days and failed-run diagnostics until explicitly cleared. Stop failed workers while preserving their tabs, transcripts, and artifacts. After a Lead crash, interrupted work requires human confirmation before resuming.
- Activate explicitly per consuming project with pinned versions; choose packaging after checking native primitives.
- Matt setup approved in Q13: AGENTS.md, local tracker, single context and default triage labels; applied under docs/agents/.

## Approval and next checkpoint

- The user approved the [specification](../../.scratch/pi-lead/spec.md), including lifecycle/policy test seams and the lifecycle/routing/persistence ADRs. Q16 established ChatGPT Pro first. Startup is measured from the first slice; no unsupported latency promise is set.
- The user approved the 16-slice breakdown and blocking edges. [Individual tickets and dependency graph](../../.scratch/pi-lead/ticket-proposal.md) are published locally; the graph covers all 42 spec stories.
- Repository initialization is authorized by that approval and bootstrap phase 6. Application implementation remains paused under the original instruction until the user asks to begin.
- The local repository is initialized on main, with no remote or GitHub repository created. Ticket 01 is the first dependency-free slice; all tickets remain unstarted.

## Research gates before specification

- Inventory installed Pi hooks, events, commands, SDK/RPC, extension capabilities and their security limits.
- Inventory version-specific Herdr lifecycle, tabs/focus, status, result collection, restore, worktrees, metadata/events, cleanup, and remote contracts.
- Verify full-worker Gondolin isolation, network/secret controls, host compatibility, and a visible Herdr terminal without exposing its control socket to workers.
- Verify official Jev contracts and whether its judgment can use an already-supported provider/model path.
- Matt entrypoints required by bootstrap section 4 have been reviewed; [workflow contracts](matt-workflow.md) record their roles. Read branch-specific references when their workflow is actually used.
- Resolve persistence and completion evidence without duplicating native lifecycle primitives.

## Sources and progress

- Initial [provider access research](../research/provider-access.md) and [sandbox boundary research](../research/sandbox-boundary.md) are written; findings are source-level evidence, not runtime validation.
- [Herdr contracts](../research/herdr-contracts.md), [Jev contracts](../research/jev-contracts.md), and [workspace/mise boundaries](../research/workspace-and-mise.md) document native primitives and remaining proof obligations.
- [Pi contracts](../research/pi-contracts.md) inventory all 37 declared extension events and 33 RPC commands for installed Pi 0.86.1, plus SDK, command and package surfaces. Pi/Herdr research gates now have source-level inventories; integration and security acceptance remain unperformed.
- [ChatGPT isolation research](../research/chatgpt-isolation.md) supports a native candidate with synthetic guest credential, explicit provider overlay and host-owned refresh/substitution; the combined behavior still requires runtime acceptance.
- The standalone specification, lifecycle/routing/persistence ADRs and all 16 ticket scopes are approved. Individual implementation tickets are published; none has started.
- No application code, runtime integration, VM launch, package installation or model call has been performed during planning. No immediate manual account action is required.
