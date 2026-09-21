# Pi 0.86.1 contracts for PI Lead

Research date: 2026-09-21. Scope: installed `@earendil-works/pi-coding-agent` **0.86.1**, not a guessed API from an older Pi release. Research only; no worker, extension, model call, credential read, package installation, or application code was executed.

## Evidence and completeness

The executable is a symlink to `dist/bundle/cli.js` in `/Users/Thibaut/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/lib/node_modules/@earendil-works/pi-coding-agent`. Its `package.json` declares version 0.86.1 and Node >=22.19.0. The shipped declarations and JavaScript, plus shipped docs, are the authoritative evidence for this installation. Upstream tag `v0.86.1` resolves for the extension types and RPC documentation; links below use that tag, not moving `main`. The tag has not been cryptographically matched to the installed tarball. No assumption that today's upstream head behaves identically is needed.

This inventory covers **all 37 `ExtensionAPI.on` event overloads**, every declared `RpcCommand` variant, built-in slash commands, documented CLI options, public extension entry points, and the session/runtime SDK surfaces relevant to orchestration. It is not an inventory of every internal helper, UI component implementation, provider-specific wire format, or experimental unpublished client API. Local declarations remain the exact signature reference where tables abbreviate nested types. No dynamic third-party command list was loaded: that would execute potentially untrusted extensions and is not necessary to inventory native Pi.

Primary-source keys:

- **[T]** [Extension declarations](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/extensions/types.ts), inspected locally as `dist/core/extensions/types.d.ts`.
- **[E]** [Extension documentation](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/extensions.md).
- **[R]** [Extension runner](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/extensions/runner.ts), inspected locally as `dist/core/extensions/runner.js`.
- **[S]** [Agent session](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/agent-session.ts), inspected as `.d.ts` and `.js`.
- **[RT]** [Session runtime](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/agent-session-runtime.ts).
- **[SDK]** [SDK guide](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/sdk.md) and [factory](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/sdk.ts).
- **[RPC]** [RPC guide](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/rpc.md) and [RPC types](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/modes/rpc/rpc-types.ts).
- **[CLI]** [Argument parser/help](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/cli/args.ts) and [slash-command registry](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/slash-commands.ts).
- **[PKG]** [Package guide](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/packages.md).
- **[SEC]** [Security guide](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/security.md).
- **[CW]** [Cache warmer](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/cache-warmer.ts).

## Decisions supported by the contracts

**Recommendation, not an accepted implementation:** keep one thin Lead extension. Use native `input` to handle natural-language intake, native `before_agent_start` for workflow context, native model/thinking setters for allowed routes, and native session events/entries for observation and correlation. Keep task transitions, policy, retry limits, resource ownership, and deterministic DONE checks in ordinary independently testable modules. Do not build a second provider client, prompt transport, extension installer, or Pi session format. [T, E, SDK, PKG]

Pi has no security sandbox. Project trust only controls loading. Extensions, shell tools, package installers, and SDK callers run with the Pi process's permissions. Even context files can load when project trust is declined. Consequently, every real worker's **entire Pi process** must be inside the agreed isolation boundary. A tool hook that denies `bash` is useful UX but does not constrain an extension's `node:fs`, `fetch`, `child_process`, provider hooks, or `pi.exec`. [SEC, T]

**Do not equate `agent_end` with DONE.** Pi can retry, compact, or run queued continuations. `agent_settled` and SDK `waitForIdle()` supply a stronger quiescence signal, but still do not prove task validation, review, artifact collection, or cleanup. Those remain PI Lead's deterministic evidence checks. Session shutdown is graceful notification, not a guarantee after crash/SIGKILL. [S, E]

## Exhaustive extension event inventory

Every row inherits the security baseline: handlers are fully privileged code inside the Pi process; none is an OS security boundary. “Observe” means no typed result changes that event; the handler still has the ordinary extension context and APIs. Except `project_trust`, handlers receive `ExtensionContext` with cwd, mode/UI, read-only session manager, model registry/current model/scoped models, idle/abort/signal/compaction helpers. `on` returns an unsubscribe function. [T]

| Event | Timing and payload (besides `type`) | Typed modification/block behavior | Security consequence and PI Lead use |
|---|---|---|---|
| `project_trust` | Before protected project resources load; `cwd`; limited trust context | Required `trusted: yes/no/undecided`, optional `remember`; first yes/no wins | Global/CLI extensions only; never infer human approval from a model. Native trust UX only. |
| `resources_discover` | After session start/reload; `cwd`, `reason: startup/reload` | Add `skillPaths`, `promptPaths`, `themePaths` | Paths load instructions/resources; useful for official workflow resources, not arbitrary repo-controlled paths. |
| `session_start` | Startup/reload/new/resume/fork; `reason`, optional `previousSessionFile` | Observe | Reconcile persisted task references; do not automatically resume interrupted work. Start session-scoped resources here, not in the factory. |
| `session_info_changed` | Session metadata name changes; `name` or undefined | Observe | Human label updates; names are not authentication or stable task identity. |
| `session_before_switch` | Before new/resume; `reason`, optional target file | `{cancel}` | Can keep live task from being accidentally detached; no protection against forced exit. |
| `session_before_fork` | Before fork/clone; `entryId`, `position: before/at` | `{cancel, skipConversationRestore}` | Must avoid replaying task side effects when branching a conversation. |
| `session_before_compact` | Before manual/threshold/overflow compaction; preparation, branch entries, custom instructions, reason, willRetry, abort signal | `{cancel, compaction}` | Custom summarizer can change remembered context; keep policy out of summarization. Extra model cost possible. |
| `session_compact` | Successful compaction; entry, fromExtension, reason, willRetry | Observe | Track context continuity, not task success. |
| `session_compact_failed` | Failed/aborted compaction; reason, errorMessage?, aborted, willRetry, fromExtension | Observe | Diagnostics and bounded failure handling. |
| `session_shutdown` | Runtime teardown for quit/reload/new/resume/fork; reason, targetSessionFile? | Observe | Idempotent cleanup; abrupt process death still needs external reconciliation. |
| `session_before_tree` | Before branch navigation; preparation with target/old leaf/common ancestor/entries/summary preference/instructions/label, signal | Cancel, provide summary/details/usage, override instructions/replaceInstructions/label | Prevent accidental side-effect replay; summary must not be policy authority. |
| `session_tree` | After tree navigation; newLeafId, oldLeafId, summaryEntry?, fromExtension? | Observe | Rebuild UI from selected branch while keeping external task ownership distinct. |
| `context` | Before each LLM call; `messages: AgentMessage[]` | Return replacement messages; runner starts from structured clone | Native context injection/filtering; not secrecy enforcement against privileged extensions. |
| `cache_warming_decision` | Before cache refresh; warmCost, missCost, continuationProbability, proposed action | Override `action: warm/stop`; stop lasts until next real request | Warming sends additional provider requests. Disable in baseline cost policy; hook failure can fall back to Pi's decision. [CW] |
| `before_provider_headers` | Headers assembled before HTTP call; mutable `headers` | Mutate in place; null deletes header; return ignored | Can see/change auth-bearing material; never log wholesale. Useful only for narrowly scoped tracing. |
| `before_provider_request` | Immediately before provider request; `payload: unknown` | Return replacement payload (provider-specific shape) | Contains prompt/tool data; do not assume generic payload schema or use this as network gate. |
| `after_provider_response` | Response received before stream consumption; status, headers | Observe | Rate-limit/request metadata only; sanitize selected fields, avoid full dumps. |
| `before_agent_start` | Accepted expanded prompt before agent loop; prompt, images?, readonly rendered systemPrompt, mutable normalized systemPromptOptions | Return custom message and/or whole systemPrompt; mutate prompt sections | Native workflow context. No typed cancel. Handler failures are logged and processing continues: not fail-closed policy. |
| `agent_start` | Agent loop begins; no additional payload | Observe | Run-start telemetry/correlation. |
| `agent_end` | Loop ends; messages | Observe | May precede retry/continuation; never close worker based only on this. |
| `agent_settled` | No automatic retry/compaction/queued continuation left; no additional payload | Observe | Quiescence candidate for collection; still not deterministic DONE. |
| `ui_prompt_start` | Blocking extension UI prompt begins; reason=ui_prompt, kind select/confirm/input/editor/custom, title? | Observe | Human-wait status; title isn't proof of an authorization. |
| `ui_prompt_end` | Blocking extension UI prompt ends; same kind/reason/title shape | Observe | Clear human-wait indicator; no answer in this event. |
| `turn_start` | Each turn begins; turnIndex, timestamp | Observe | Timing/retry instrumentation; turn is not task. |
| `turn_end` | Turn ends; turnIndex, assistant message, toolResults | Observe | Tool batch outcomes; still untrusted evidence. |
| `message_start` | User/assistant/tool-result message begins; message | Observe | Transcript progress; may contain sensitive content. |
| `message_update` | Assistant streaming; message, assistantMessageEvent | Observe | Native text/thinking/tool deltas; do not create a parallel stream parser if SDK/RPC is available. |
| `message_end` | Message finalizes; message | Return replacement message with same role; invalid role ignored/logged | Transcript can be rewritten before persistence: not tamper-proof audit. [R, S] |
| `tool_execution_start` | Tool execution begins, before `tool_call`; toolCallId, toolName, args | Observe | Start event is not proof tool was allowed/executed. |
| `tool_execution_update` | Tool partial output; toolCallId, toolName, args, partialResult | Observe | Output is untrusted; truncate/sanitize when displaying. |
| `tool_execution_end` | Tool finishes; toolCallId, toolName, result, isError | Observe | Execution evidence, not independent validation. |
| `model_select` | Model changes; model, previousModel?, source=set/cycle/restore | Observe | Audit actual route; cannot veto via result. Gate selection before invoking setters. |
| `thinking_level_select` | Thinking changes, including model clamping; level, previousLevel | Observe | Record effective level rather than requested level. |
| `tool_call` | Before actual tool invocation; toolCallId, toolName, input | Mutate input in place (no revalidation); `{block, reason, terminate}` | Block/throw prevents call; other code paths remain privileged. Terminate only stops batch loop when all finalized results request it. Useful defense in depth and human UX. |
| `tool_result` | After execution; toolCallId, toolName, input, content, details, isError, usage? | Replace content/details/isError/usage | Cannot undo effects; modified result is not trusted external evidence. |
| `user_bash` | `!`/`!!` shell command; command, excludeFromContext, cwd | Return custom BashOperations or completed BashResult; undefined uses local shell | Separate from model tool calls. Runner propagates handler failure; must cover this path if redirecting tools, but whole-process isolation remains required. |
| `input` | After extension command dispatch, before skill/template expansion; text, images?, source=interactive/rpc/extension, streamingBehavior=steer/followUp/undefined | continue, transform text/images, or handled; transforms chain, first handled wins | Correct natural-language intake seam. Handler errors are logged and input continues: no security guarantee. Avoid rerouting self-injected messages or duplicating streaming task creation. |

All event signatures and return capabilities above derive from [T, CW]; timing/order and chaining were checked in [E, R, S]. `tool_call` sees session history synchronized through the assistant message, but parallel sibling tool results need not yet appear. Mutable input patches are not schema-validated again. Do not design admission policy around a supposedly immutable event stream.

## Intake and before-agent sequence

Native prompt ordering is: extension slash command dispatch → `input` → skill expansion → prompt-template expansion → `before_agent_start` → agent loop. A registered `/lead` escape hatch bypasses `input`, so its handler must invoke the same task-admission function explicitly. Input sees `/skill:name` before expansion. `before_agent_start` sees expanded text and can shape prompt sections; a returned whole prompt overrides the rendered prompt for that run. [E, R, S]

`input` carries source and streaming behavior; this is enough to distinguish normal user intake, queued steering/follow-up, and extension-injected continuation. `handled` prevents the normal model turn and requires the extension to provide its own visible feedback. `sendUserMessage` always triggers a turn, so naïvely calling it on every input can cause recursion. The SDK prompt preflight callback acknowledges acceptance, queueing, or immediate handling; it is not task completion. [T, SDK, S]

Policy recommendation: record admission first, provide deterministic feedback when routing fails, and do not rely on throwing from `input` or `before_agent_start` to fail closed. Their runner catches errors. Privileged policy must remain outside the worker and enforce actual OS/network/resource permissions. [R, SEC]

## Native extension API surface

| Surface | Contract and purpose | Security/use for PI Lead |
|---|---|---|
| `registerTool` | Typed schema, execute(toolCallId, params, signal, onUpdate, ctx), rendering hooks; may override built-in name; dynamic registration supported | Narrow coordination actions; custom execution is fully privileged. |
| `registerCommand`, `getCommands` | Slash name/options with handler and argument completion; get commands/source metadata | Optional escape hatch; use same policy as natural language. |
| `registerShortcut`, `registerFlag`, `getFlag` | Shortcut context handler; boolean/string CLI options | Optional UX, not needed for initial intake. |
| `registerMessageRenderer`, `registerEntryRenderer`, `registerMarkdownTransformer` | Custom transcript rendering; entries versus messages have different context semantics | Native task cards/status; display rendering is not audit integrity. |
| `sendMessage` | Custom message; optional triggerTurn; deliverAs steer/followUp/nextTurn | Worker result summary/context; untrusted content must not confer permissions. |
| `sendUserMessage` | Text/content; deliverAs steer/followUp; optional command/template expansion | Explicit continuation; avoid recursion and unintended command execution. |
| `appendEntry` | Custom typed data persisted in session, excluded from LLM context | Correlation IDs/status references; do not use as sole worker ownership store. |
| `setSessionName`, `getSessionName`, `setLabel` | Native session names and branch entry labels | Semantic labels; stable task ID kept separately. |
| `exec` | Execute program plus args/options, returns output/code | Host capability: never expose raw untrusted commands through trusted Lead. |
| `getActiveTools`, `getAllTools`, `setActiveTools` | Enumerate/select named tools; getAllTools includes schemas/guidelines/source | Reduce available model tools; not a sandbox. |
| `setModel`, `getThinkingLevel`, `setThinkingLevel` | `setModel(model): Promise<boolean>` false for unavailable auth; thinking clamped; session-only defaults | Deterministic allowed route map; record actual values and fail explicitly rather than silently selecting paid fallback. |
| `registerProvider`, `unregisterProvider` | Native Provider or named config; model list, endpoints, auth/OAuth/custom stream support | Existing providers should be reused; provider extensions are trusted code with auth access. |
| `events` | Shared in-process event bus | Extension coordination only; not authenticated interprocess transport. |

`ExtensionContext` additionally exposes `isProjectTrusted`, `isIdle`, `signal`, `abort`, `hasPendingMessages`, `shutdown`, `getContextUsage`, `compact`, `getSystemPrompt`. Model registry access can resolve credentials; it is not a secret-free view. `ExtensionCommandContext` adds `getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`; replacement callbacks supply the new session context. Session replacement invalidates old extension instances. [T, RT]

UI methods: `select`, `confirm`, `input`, `editor`, `notify`, `onTerminalInput`, `setStatus`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setWidget`, `setFooter`, `setHeader`, `setTitle`, `custom`, `pasteToEditor`, `setEditorText`, `getEditorText`, `addAutocompleteProvider`, `setEditorComponent`, `getEditorComponent`, `getAllThemes`, `getTheme`, `setTheme`, `getToolsExpanded`, `setToolsExpanded`, and readonly `theme`. TUI has full UI; RPC has dialogs/notifications but no arbitrary TUI components; print/JSON have no interactive UI. Check `ctx.mode`, not merely `hasUI`, for terminal-specific behavior. [T, E]

## RPC command inventory

RPC is JSON lines on stdin/stdout via `--mode rpc`; optional request IDs correlate responses. It is headless, not a second TUI endpoint on the same process. No authenticated network server is implied. Responses carry command/success and data or error. A `prompt` success acknowledges acceptance, not completion. Use existing event stream and response correlation rather than inventing a command protocol. [RPC]

| Commands (all declared variants) | Inputs/data and effect | PI Lead/security interpretation |
|---|---|---|
| `prompt` | message, images?, streamingBehavior? | Native intake; admission acknowledgement only. |
| `steer`, `follow_up` | message, images? | Queue interruption after tools / later continuation; can alter work, requires task ownership. |
| `abort`, `clear_queue` | no additional inputs; clear returns steering/followUp removed | Native stop primitives; verify idle/process termination separately. |
| `new_session` | parentSession?; cancelled result | Replaces active session; do not silently discard task tracking. |
| `get_state` | model, thinking, streaming/compacting, queue modes, session identifiers/name, count/settings | Read status; insufficient for DONE. |
| `set_model` | provider, modelId; returns selected model | Existing provider routing; allowed-list policy external. |
| `cycle_model`, `get_available_models` | cycle returns model/thinking/isScoped or null; listing models | Never cycle nondeterministically for budget fallback. |
| `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` | level or effective level(s) | Use supported levels; record clamping. |
| `set_steering_mode`, `set_follow_up_mode` | all/one-at-a-time | Controls queue delivery, not parallel worker scheduler. |
| `compact`, `set_auto_compaction` | customInstructions? / enabled | Context maintenance may call model. |
| `set_auto_retry`, `abort_retry` | enabled / no fields | Provider retry is separate from bounded review/fix attempts. |
| `bash`, `abort_bash` | command, excludeFromContext?; BashResult | Direct privileged execution inside worker boundary; do not expose to untrusted host callers. |
| `get_session_stats` | tokens, messages/tool counts, cost/context estimate | Observability, not enforceable billing cap. |
| `export_html` | outputPath?; path | Writes export; transcript can contain sensitive material. |
| `switch_session` | sessionPath; cancelled | Path selection must be owned by controller. |
| `fork`, `clone` | entryId / no fields; cancellation/text as applicable | Conversation branches are not new OS-isolated workers by themselves. |
| `get_fork_messages` | entries with IDs/text | Native branch selector data. |
| `get_entries` | optional since entry ID; entries and leafId | Native incremental transcript collection; handle branch identity. |
| `get_tree` | tree, leafId | Native branch structure. |
| `get_last_assistant_text`, `get_messages` | text/null / messages | Result collection candidate; assistant text is not authoritative success. |
| `set_session_name` | name | Human-facing naming. |
| `get_commands` | extension/prompt/skill commands with source metadata | Does not enumerate built-in interactive commands as runnable RPC slash commands. |

UI requests use `extension_ui_request` plus ID and method: select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text. Dialog answers use `extension_ui_response` with value, confirmed, or cancelled. This response is not a `RpcCommand` variant. A UI client must answer or cancel pending dialogs; `hasUI` in RPC does not mean a human is actually present. [RPC]

SDK/RPC session observation includes core agent/turn/message/tool events plus `agent_settled`, `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `compaction_start/end`, `auto_retry_start/end`, `summarization_retry_scheduled`, `summarization_retry_attempt_start`, `summarization_retry_finished`, and `bash_execution_update`. SDK `agent_end` includes `willRetry`, unlike extension `agent_end`. Summarization retries distinguish compaction and branch summary. Do not assume extension event names and RPC/SDK event names match one-for-one. [S, RPC]

## SDK lifecycle and persistence

`createAgentSession` accepts cwd, agentDir, ModelRuntime, model/thinking/scopedModels, tool allow/deny/default selection, customTools, ResourceLoader, SessionManager, SettingsManager, and sessionStartEvent. It returns session, extension load results, and possible modelFallbackMessage. Defaults discover resources and credentials; an isolated worker needs explicit worker-owned directories/runtime inputs. `SessionManager.inMemory()` is native for tests; normal SessionManager already owns durable Pi conversation trees. [SDK]

`AgentSession` manages one session: prompt/steer/followUp/custom/user messages; queue inspection/clear; subscribe/dispose; abort/waitForIdle; model/thinking/scoped models; tool enumeration/selection; compaction/branch-summary abort; auto retry enable/abort; extension bind/reload; bash execute/record/abort; session name/tree navigation; fork-message enumeration; stats/context usage; HTML/JSONL export; last assistant text. Read properties include model/runtime/state/messages, system prompt, session IDs/file/name, streaming/idle/compaction/retry/bash flags, pending queues, resourceLoader, promptTemplates, cache warming status. Native setCacheWarmingMode exists. [S]

`AgentSessionRuntime` owns replacement via newSession/switchSession/fork/importFromJsonl, with clone as fork at the current entry. It tears down and recreates cwd-bound services. Session subscriptions and extension bindings must be reattached after replacement; old context handles are stale. If recreation fails it throws after teardown: do not assume old live runtime survives. Native factory/service constructors are `createAgentSessionRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`. [RT, SDK]

`ModelRuntime` owns provider/auth/catalog resolution and can use in-memory credential stores. This eliminates a need for custom provider adapters for built-in providers. But an in-memory API key in the **worker process** still violates a requirement that arbitrary worker code cannot read raw credentials; secret-bearing access must stay outside that boundary. Native model defaults may restore/fall back to first available model, so PI Lead should supply an exact allowed route and treat missing auth/model as BLOCKED. [SDK, SEC]

`appendEntry` is sufficient for task correlation breadcrumbs, but conversation fork/tree/compaction and cross-worker/process ownership justify a small external task record. This is a design inference, not a requirement to introduce a database or distributed workflow engine. Reconcile that record with real process/VM state after restart; require user confirmation before resuming interrupted work.

## Commands and installation

All built-in slash commands in the installed registry: `/settings`, `/model`, `/tree`, `/thinking`, `/scoped-models`, `/export`, `/import`, `/share`, `/bug`, `/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`, `/trust`, `/login`, `/logout`, `/new`, `/compact`, `/resume`, `/reload`, `/quit`. Their surfaces cover configuration/model selection, transcript/tree lifecycle, publishing/export, authentication and exit. `/share` publishes a secret GitHub gist: “secret” is not private access control and publication must follow the human policy. `/bug` and exports can disclose transcript data. No command here is a task-security boundary. Built-ins are handled by interactive mode; use explicit RPC methods for supported remote operations. [CLI, RPC]

CLI management commands: `install`, `remove`/`uninstall`, `update`, `list`, `config`, `auth`. Auth includes credential-printing operations; do not use them for capability inspection or log capture. Public flags are grouped below (aliases in installed help): [CLI]

| Group | Options | Meaning/security |
|---|---|---|
| Provider/prompt | `--provider`, `--model`, `--api-key`, `--system-prompt`, repeatable `--append-system-prompt`, `--thinking`, `--models` | Explicit route/prompt; never put real secrets in argv. Model scope is selection UX, not isolation. |
| Mode | `--mode text/json/rpc`, `--print/-p`, `--tui-mode regular/fullscreen` | Choose native process interface. |
| Session | `--continue/-c`, `--resume/-r`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`, `--name/-n` | Reuse native persistence with worker-owned storage. |
| Tools | `--no-tools/-nt`, `--no-builtin-tools/-nbt`, `--tools/-t`, `--exclude-tools/-xt` | Select model tool exposure; do not disable arbitrary extension capabilities. |
| Resources | repeatable `--extension/-e`, `--skill`, `--prompt-template`, `--theme`; `--use-theme`; `--no-extensions/-ne`, `--no-skills/-ns`, `--no-prompt-templates/-np`, `--no-themes`, `--no-context-files/-nc` | Bound discovery; explicit `-e` still loads with no-extensions. Context discovery needs its own flag. |
| Trust/network | `--approve/-a`, `--no-approve/-na`, `--offline` | Trust only controls resource loading. Offline disables startup network operations, not general provider/extension/shell networking. |
| Utility | `--export`, `--list-models`, `--verbose`, `--help/-h`, `--version/-v`, `--`, `@file` arguments | Exports write data; list-models can load extension factories. Argument files enter context. |

Native packages bundle extensions, skills, prompts and themes under a `pi` manifest or conventional directories. A project-local pinned install is `pi install -l npm:<package>@<version>`; no custom installer necessary. `-l` writes `.pi/settings.json`; default installs are global. Missing trusted project packages auto-install at startup, which has network and code-execution implications. Global/project resource filters allow excluding unnecessary components. Versioned npm specs are pinned and skipped by bulk updates; git refs remain pinned but reconciliation can reset/clean the package checkout. `npmCommand` can explicitly run npm through mise. [PKG]

Extensions are synchronous/asynchronous default factories loaded via jiti. Async factories are awaited before session start/resource discovery. Factories may execute during utility invocations without a session; do not start persistent resources there. Put startup in session_start and idempotent teardown in session_shutdown. Pi core imports belong in peerDependencies per native package guidance; other runtime dependencies in dependencies. No third-party extension is needed for the intake/model/observability contracts identified here. [E, PKG]

## Remaining checks before implementation approval

1. Herdr plus whole-worker VM integration: prove a visible per-worker tab, background creation preserving Lead focus, machine-readable lifecycle/result collection and graceful stop. RPC is headless; this note does not establish that Herdr can display the same RPC worker natively.
2. Credential mediation: verify the selected providers work through host-side injection/proxy without raw credential access inside the VM; SDK in-memory auth alone does not satisfy this. Parallel provider research found that installed OpenAI Codex request code parses the access-token JWT to extract the account ID before sending the HTTP request. A plain placeholder replaced only at network egress will therefore not work unchanged; see [provider access research](provider-access.md) for the provider-specific evidence and options.
3. Runtime contract tests in later authorized tickets: input self-message/streaming behavior; failure while admitting input; model mismatch/fallback; agent_settled with retries/queued follow-up; crash reconciliation; SIGKILL cleanup; package trust/discovery. No runtime prototype was executed in this research phase.
4. Cost policy must account for compaction, summarization retries and cache warming, beyond ordinary agent turns. Disable optional warming in the baseline configuration and distinguish provider retries from review/fix cycles. Provider billing controls remain separate from Pi's estimated usage.
5. Pin the actual release for consumers and rerun this inventory on upgrades. This version contains significant native session-runtime and settled-event capabilities that older integration examples may omit.
