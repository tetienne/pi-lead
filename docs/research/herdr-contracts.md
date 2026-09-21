# Herdr 0.8.0 contracts for isolated workers

Research date: 2026-09-21. Scope: every area required by bootstrap section 8, with detailed attention to host control of guest Pi. Documentation and source inspection only; no session inspection/control, installations, agent launches, or VM experiments. Source was downloaded into `/tmp` for reading. The installed binary reports `herdr 0.8.0`; its offline `api schema` reports protocol **19**, schema version **1**. The running server version was not queried and must be checked during integration validation.

Primary-source baseline: tag `v0.8.0`, commit [`346411fa21afd297f5ed3b3fa56f9e3fbf7654b7`](https://github.com/herdrdev/herdr/tree/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7). Links below use that immutable commit. Documentation under `docs/next` is the documentation shipped in this source revision, not today's unversioned website. Critical findings were checked against Rust/TypeScript source and installed help. This is a scoped contract inventory, not a claim that runtime integration has passed.

## Conclusions that simplify the design

1. **Guest-agent recognition has a native mechanism.** On Linux and macOS, setting `HERDR_AGENT=pi` on the **host-visible foreground wrapper process** selects the existing Pi screen manifest. Setting it only inside the VM does nothing for host process detection. Use a per-command hint, not a global export. This can remove the need for custom process detection. Actual Gondolin wrapper visibility still needs a fixture test. [Detection documentation][agents] [Environment parser][platform]
2. **A named background tab already exists as a primitive.** `tab create --workspace <id> --label <name> --cwd <path> --no-focus` returns the tab and root pane. No custom layout manager, mosaic, or workspace per worker is required. [Tab schema][tabs]
3. **Herdr status is not task completion.** `done` is an unseen idle agent; prompt waits track state transitions, not request/turn completion. The bundled Pi screen manifest only recognizes `Working...`, with generic known-agent idle fallback otherwise. It cannot reliably detect guest Pi failures, validation success, or all human gates. [Installed skill source][skill] [Pi manifest][manifest] [Wait implementation][wait]
4. **Native status reporting is sufficient on the Herdr side.** A trusted host adapter may report through `pane.report_agent` using its own source such as `custom:pi-lead`. The guest must never receive the Herdr socket or an unrestricted forwarding proxy. The guest-to-host telemetry channel and exact Pi turn correlation remain unresolved integration seams; Herdr does not supply them. [Report handlers][panes] [Terminal authority][authority]
5. **Do not feed guest sessions into Herdr's native Pi restore.** Official `herdr:pi` session references produce a host `pi --session <path-or-id>` resume command. Custom-source session references are ignored for native restore. Keeping guest session identity in PI Lead's own run record avoids host launch and unintended resumption, without changing every user's global Herdr setting. [Resume source][resume]

## Inventory

| Area | Native surface and verified semantics | PI Lead use / limit |
| --- | --- | --- |
| Workspaces | Create/list/get/focus/rename/close; API move and move-block; metadata. A workspace owns tabs and working-directory context. Creation returns workspace, tab, root pane. | Reuse the consuming project's workspace. Always target explicit IDs; omitted targets can mean another client's focused resource. |
| Tabs | Create/list/get/focus/rename/close; API move. Creation has `cwd`, label, environment, and `focus` (false in schema). | One dedicated named tab per important worker, explicitly `--no-focus`; store returned IDs. Closing the last tab can close its workspace, so cleanup must verify ownership/topology. |
| Layouts | `layout.export`, `layout.apply`, `layout.set_split_ratio`; pane split/swap/move/zoom/resize/neighbor/edges/layout. | Existing tree layout handles terminals. No requirement to use splits for workers. Layout restore does not restore arbitrary processes. |
| Panes | List/current/get/process-info/read/rename, input, run, close, output waits, status/session/metadata reports. Pane exists independently of an agent. | Launch the trusted wrapper as an ordinary pane command. Preserve the shell on failure so the diagnostic tab survives worker termination. |
| Agent identity | List/get/explain/rename/focus/read/send-keys/prompt/wait/start/attach; API view filters/sorting. Names must match `[a-z][a-z0-9_-]{0,31}` and be live-unique. | Semantic tab names persist independently of occupant names. Names are cleared when the occupant exits/is released/replaced. Public IDs are opaque, not sidebar positions. |
| Agent launch | `agent start <name> --kind pi --pane <id> -- <args>` requires an available interactive shell and invokes the canonical supported executable. Default readiness timeout 30s, maximum 300s. | It is not a generic Gondolin launcher parameter. Prefer native pane command launch plus process hint/status reports, instead of shadowing `pi` on PATH to trick this API. |
| Agent lifecycle | `idle`, `working`, `blocked`, `done`, `unknown`; one authoritative status source. Screen-manifest fallback and full lifecycle hooks have different authority rules. | Treat these as UI/coordination evidence; policy-owned DONE requires collected results, passed validations/review, and cleanup. `blocked` here means detected interaction, not necessarily PI Lead BLOCKED. |
| Prompt/wait | Prompt atomically sends text and Enter, honoring bracketed paste. Optional wait pins terminal/agent identity; default settled states idle/done/blocked. | Serialize assignments to one worker. A prompt while already working can be satisfied by the existing turn. Timeouts do not cancel execution. |
| Read/output | visible/recent/recent-unwrapped/detection; text or ANSI. Output waits search the existing snapshot immediately. | Read is diagnostic, not a complete transcript or trusted result protocol. Old output can satisfy a new output wait. Alternate-screen rows may never enter host scrollback. |
| Socket/API | Newline JSON requests/responses, matching request IDs; local Unix socket on target platforms, owner-only `0600`; schema includes requests, responses, errors, events. | CLI for simple operations, direct API only for persistent subscriptions or structured integration. Socket possession gives broad session control; a source label is not authentication. |
| Official Pi integration | Bundled extension reports lifecycle and native session identity over direct socket access. | Appropriate for trusted host Pi, not directly for guest Pi. See precise event behavior below. |
| Persistence | Detached client leaves server/processes live. Restart restores shape/cwd/focus; screen replay optional, native agent restore separately enabled by default. | PI Lead must reconcile VM/process ownership independently; restored tabs are not proof that workers survived or should resume. |
| Worktrees | `worktree.list/create/open/remove`; create/open also creates/opens a worktree workspace with provenance; creation supports branch/base/path/label/focus. Remove has explicit force. | Useful when a worktree-backed workspace is wanted; not a sandbox. Shared Git metadata and host paths need separate isolation design. Do not force removal on cleanup. |
| Metadata | Pane presentation fields plus pane/workspace token maps; source, sequence, optional TTL. | Useful for task/model/run labels. Display metadata cannot authorize actions, make a task DONE, or serve as durable state. |
| Events | Native resource subscriptions, state/output waits, snapshot bootstrap. | Subscribe for responsiveness, resnapshot on reconnect, reconcile against durable run records. Not a durable job/event log. |
| Cleanup | Pane/tab/workspace close removes terminal resources; custom authority clear/release are separate state operations. | Collect before close; VM close and termination confirmation remain required. Releasing an agent does not kill it. Never stop the entire server to clean one worker. |
| Remote | Native SSH thin-client attach, remote named sessions, native remote platform/version handling. | Defer remote worker execution. Native remote attach solves human access to a remote Herdr server, not per-worker sandboxing. |

Inventory sources: [installed skill][skill], [socket API documentation][api], [workspace schema][workspaces], [tab schema][tabs], [agent schema][agent-schema], [worktree schema][worktrees], [session documentation][session], [remote documentation][remote]. Installed `--help` for all named CLI groups and `tab create`, `agent start`, `pane report-agent`, `pane report-agent-session` corroborated syntax. No control command was executed.

## Pi recognition and the official integration

Herdr first identifies the host foreground process; `HERDR_AGENT` supplies an existing recognized agent identity for wrappers. The Linux implementation reads process environment and macOS reads process argument/environment data. This is platform-native support in 0.8.0, not a proposed extension. A host wrapper must retain the hint on the process actually detected. The Pi manifest contains only one working-state rule; absent a matching rule, a recognized agent can look idle. Remote/local manifest overrides can also change behavior without a binary upgrade, so the eventual integration check must inspect active manifest source/version with `agent explain` or `server.agent_manifests`. [Platform source][platform] [Manifest][manifest] [Agents documentation][agents]

The bundled Pi extension is integration version **8**, source `herdr:pi`. It requires `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. It activates on `session_start` only when `ctx.mode === "tui"`; RPC/JSON/print sessions deliberately do not report. It records session identity, reports working on `agent_start`, and reports idle on `agent_settled` only if `ctx.isIdle() === true`. The custom `herdr:blocked` bus event maintains a blocked counter. It sends monotonic sequence values, coalesces queued state updates, and retries socket delivery once. Delivery regards any response bytes as success rather than validating application acceptance. This integration is observability, not reliable task acknowledgment. [Bundled Pi extension][pi]

A minimal trusted adapter can use `pane.report_agent` for the wrapper pane with a custom source and no native session fields, and `pane.report_metadata` for display. Herdr accepts custom lifecycle authority, but can ignore conflicting or stale reports while returning API success. Therefore check the resulting `agent.get` state/identity where operational correctness depends on acceptance. Do not claim a fully working guest bridge until reporting, input, cancellation and stale-event behavior are tested. [Report handlers][panes] [Authority implementation][authority]

## Correlation, events, and durable evidence

`agent prompt --wait` demands an observed lifecycle change within five seconds when submitted from a non-working state, otherwise `agent_prompt_stalled`; shorter explicit timeouts win. Its wait is server-owned and guards against replacement occupants. It still does not correlate an assignment to its final result. Standalone wait can immediately match an already settled state. Neither a wait match nor a visible “done” label proves success. [Wait implementation][wait] [CLI specification][cli]

PI Lead should bind its own task/run/attempt ID to the returned Herdr IDs, VM identity, and Pi session/assignment identity. One outstanding assignment per worker is the simplest starting contract. A guest completion signal is untrusted evidence and must not trigger privileged host commands or bypass validation. Whether Pi's native APIs permit correlation while retaining the native visible TUI must be resolved jointly with the Pi inventory; do not invent a second terminal or prompt protocol in this note.

Subscriptions cover workspace create/update/metadata/rename/move/reorder/close/focus; worktree create/open/remove; tab create/close/focus/rename/move; pane create/update/close/focus/move/exit/agent-detected/status-changed/output-match/scroll; and layout updates. Some filters are pane-specific; general topology streams require client filtering. Plugin hooks intentionally omit high-volume pane updates/output, layout, and workspace metadata events. `session.snapshot` supplies current topology/layout/agent records; there is no durable replay cursor contract. The internal event hub retains only **512** in-memory events. Reconnect and handoff can interrupt requests, waits, and streams; resnapshot and reconcile rather than treating an event gap as success or automatically resubmitting non-idempotent prompts. [Event schema][events] [Event hub][hub] [Session documentation][session]

Metadata supports source-specific sequencing, guarded presentation fields, token patches (null clears), and TTL up to one day. A report may change at most 16 token keys; a resource holds at most 32. Text is normalized/capped. Tokens are not restored after server restart. They can aid diagnosis but cannot be the run database. [API documentation][api]

## Restore and cleanup boundaries

Herdr's detach semantics keep work running, while a full server restart loses arbitrary processes and restores shells/layout. Pane-history replay is off by default and may contain secrets. Native Pi restore is on by default and resumes eligible official session references without waiting for each tab to be focused. Source validation accepts only official source/agent pairs for resumable sessions; a custom adapter should retain guest identity elsewhere. This is particularly relevant to the accepted policy that interrupted work awaits human confirmation. [Session documentation][session] [Resume implementation][resume]

Closing a tab unregisters its panes; dropping `PaneRuntime` shuts down PTY I/O and runs its owned-process termination policy unless process preservation is explicitly active for handoff. This does not establish Gondolin VM closure or artifact durability. The host owner must collect result/logs/session evidence, close the VM using Gondolin's lifecycle API, verify termination, then close a successful worker tab. On failure it should retain a diagnostic shell/tab and artifacts with no autonomous guest still running. User-driven tab closure, wrapper crash, host crash and Lead restart each need reconciliation tests. [Tab close implementation][tab-close] [Pane runtime][runtime]

Worktree removal and tab removal are distinct. Herdr's worktree helpers manage Git checkouts plus workspace provenance, but mounting a linked worktree does not confine access to shared Git metadata. Keep this as a sandbox filesystem design obligation. Remote attach already supports macOS/Linux on x86_64/aarch64 and can locate mise installations; that support claim does not validate the Gondolin image/toolchain matrix. [Worktree schema][worktrees] [Remote documentation][remote]

## Remaining proof obligations before claiming the first slice works

- Launch a harmless guest fixture in a worker tab without moving Lead focus; verify returned IDs, stable semantic naming, wrapper hint, resize/input and visible output on each supported host architecture.
- Prove guest Pi lifecycle reports reach only the owning host adapter; inject stale/forged/oversized/misrouted telemetry and confirm no socket/API authority crosses into the guest.
- Prove one assignment's result cannot be mistaken for prior output, prior turn, replacement worker, or a mere idle transition; cover prompt stall, blocked UI, disconnect, timeout and cancellation.
- Prove result/log collection precedes cleanup and that guest termination survives tab closure, wrapper failure and Lead crash. Retained failure tabs must remain useful without live autonomous work.
- Prove cold Herdr restore does not launch guest work as host Pi and Lead restart does not resume interrupted assignments without the accepted human gate.

These are implementation acceptance criteria, not requests to implement now. No community extension, custom layout system, or generic guest access to Herdr is justified by the inspected contracts.

[skill]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/skills/herdr/SKILL.md
[agents]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/docs/next/website/src/content/docs/agents.mdx
[platform]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/platform/mod.rs
[manifest]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/detect/manifests/pi.toml
[pi]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/integration/assets/pi/herdr-agent-state.ts
[api]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/docs/next/website/src/content/docs/socket-api.mdx
[workspaces]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/workspaces.rs
[tabs]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/tabs.rs
[agent-schema]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/agents.rs
[panes]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/app/api/panes.rs
[authority]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/terminal/state.rs
[resume]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/agent_resume.rs
[wait]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/wait.rs
[cli]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/cli/spec.rs
[events]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/events.rs
[hub]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/event_hub.rs
[session]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/docs/next/website/src/content/docs/session-state.mdx
[remote]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/docs/next/website/src/content/docs/persistence-remote.mdx
[worktrees]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/api/schema/worktrees.rs
[tab-close]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/app/api/tabs.rs
[runtime]: https://github.com/herdrdev/herdr/blob/346411fa21afd297f5ed3b3fa56f9e3fbf7654b7/src/pane.rs
