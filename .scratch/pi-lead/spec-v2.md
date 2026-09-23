# PI Lead — specification v2

Status: approved 2026-09-22 (supersedes `spec.md`; see
[ADR 0005](../../docs/adr/0005-lead-is-a-tool-driven-conversation.md)).

## Promise

Talk to one Pi session in plain language. Questions get answers. Ideas are
shaped with Matt Pocock's skills. Ready tickets, bugs, reviews and research
are handed to sandboxed workers that appear as background Herdr tabs, each on
a model Jev picked for the task. Nothing needs a command.

## Behaviour

| The user… | The Lead… |
|---|---|
| asks a question | answers it from the code; no worker, no file change |
| brings anything else | reads ask-matt and follows the flow it names (grill-with-docs → to-spec → to-tickets, triage, wayfinder…) in the conversation |
| hands over a ready ticket | calls `delegate` (implement); Jev checks readiness first |
| needs a throwaway prototype | `delegate` (prototype) |
| reports a bug | `delegate` (debug), worker follows diagnosing-bugs |
| asks for a branch review | `delegate` (review) from that branch, worker follows code-review |
| needs web research | `delegate` (research), network filtered by Jev |

`delegate` returns immediately; each worker result (summary, local branch,
commits, diff stat, Jev's verdict, "Next") arrives later as a message, so the
conversation goes on while workers run. A worker that stops on a question
(needs_human, partial, blocked) keeps its tab; the Lead relays the user's
answer with `worker` (message) and the worker reports again. `worker` also
lists and stops workers. Nothing is pushed or merged.

Tabs: only the Lead's own pane stays. A done worker's tab closes at once; a
waiting one after `waitingTimeoutMinutes` without an answer (the Lead is told
it timed out); every remaining worker tab, including failed ones kept for
inspection, when the Lead session ends. Task dirs record their tab
(`tab.json`), so a Lead that starts after a crashed one closes the orphaned
tabs and removes their dirs. Worker panes show a title, `pi-lead <kind>`,
model, thinking, branch, worker id and state in Herdr (display metadata only,
best-effort) and get an agent name `lead-<slug>-<id4>`.

## Jev judgments

Each maps a closed-set answer to a deterministic action; no answer, low
confidence or no key ⇒ the listed fallback.

| Where | Question | Action | Fallback |
|---|---|---|---|
| before spawn | difficulty score 0–4 | tier fast/standard/deep → configured model + thinking | standard (implement, research), deep (debug, review) |
| before implement | acceptance criteria? bounded? decided? | refuse with reasons until clarified or user-confirmed | delegate |
| worker egress | is this request needed for the ticket? | allow / deny / ask the human in the worker tab | ask the human; deny without UI |
| after finish | real state of the work | the more pessimistic of worker and Jev wins | worker's status |
| after review | severity 0–4 | none / auto-fix follow-up / escalate to user | findings only |
| launch failure | transient / environment / task bug / needs info | one automatic retry when transient | report |
| concurrent tickets | would they edit the same things? | serialize | serialize code-writing tickets |

Budget: one `jev.dailyBudgetUsd` (default 1 USD) shared by the Lead and its
workers through `~/.pi/agent/pi-lead/jev-usage.json`.

## Isolation

- Worker Pi runs on the host with `--no-approve --no-extensions
  --no-builtin-tools`, the worker extension and Herdr's Pi integration only.
  It gets the same skills and prompts as the Lead (package, global, and the
  repo's own when the project is trusted); see ADR 0006.
- `read/write/edit/bash/ls/find/grep` and `!` shell commands run in a Gondolin
  VM. The guest gets a fixed minimal environment (never the host's), a
  disposable clone at `/workspace`, the project's mise toolchains read-only at
  `/opt/mise`, and HTTP(S) egress filtered per request; internal ranges and
  WebSockets are blocked.
- `grep` and `find` run inside the guest (its own `grep`/`find`, argv only,
  no symlink following, time-boxed); the host only reads their bounded output
  and never reads guest files or runs a regex over guest content.
- The host only `git fetch`es the worker branch from the clone; it never runs
  git inside the guest-writable directory. The worker's Pi and its tab shell
  run in a task directory outside the clone and read host copies of the
  repository's context files, skills and prompts (no symlinks followed).
- Egress: allowlisted hosts are trusted for downloads only (GET/HEAD and git
  fetch); uploads are judged by Jev per path, then by the human per host.
- Lead → worker messages go only through `herdr agent prompt` to a live
  agent; nothing is ever typed into a pane shell.

## Toolchains

`mise install` runs once per project and mise configuration in a warm-up VM
(egress: mise's download hosts, then Jev, then the human in the Lead), into
`~/.pi/agent/pi-lead/toolchains/<project>`. Workers mount it read-only.

## Configuration

`~/.pi/agent/pi-lead.json`, overridden by `.pi/pi-lead.json` in trusted
projects: `tiers.{fast,standard,deep}.{model,thinking}`, `maxWorkers`,
`sandbox.{image,allowedHosts,memory,cpus}`, `jev.{apiKeyEnv,via,model,
dailyBudgetUsd,minConfidence}`, `keepFailedWorkers` (the directory survives
the Lead; the tab does not), `waitingTimeoutMinutes` (default 120, 0 disables).

## Known limits / follow-ups

1. The Debian image and the mise warm-up have not been run end to end yet
   (the development sandbox has no Docker and blocks the Alpine CDN).
2. Lead → worker messages use `herdr agent prompt`; not yet exercised
   against a live Herdr.
3. The Lead itself still runs Pi's tools on the host (it writes specs and
   tickets), and worker reports reach it as text written by a sandboxed model.
   Mitigated deterministically by `src/report-guard.ts` (config `leadGuard`,
   default `confirm`; only the global config can set `off`): from the moment a
   `pi-lead-worker` message is in the conversation (seen on `message_end` or
   in `context`) until the human types a message that reaches the model, every
   Lead `tool_call` outside `read/ls/find/grep/delegate/worker` — bash,
   powershell, write, edit, other extensions' tools — needs `ui.confirm`
   (sanitized preview), and is blocked without a UI. Remaining gaps: an
   approved call runs unsandboxed; the human can approve a harmful command;
   read-only tools still let a report steer what the Lead reads into its
   context; RPC input never counts as the human, so RPC front ends confirm
   until the session restarts.
4. Jev thresholds are defaults, not calibrated; collect real judgments and tune.
5. The waiting timeout counts from the worker's last result or Lead message;
   a user answering directly in the worker's tab does not reset it. Herdr
   metadata, `agent rename` and `tab list` have not been exercised against a
   live Herdr yet (the `tab list` JSON shape is read as "any `tab_id`").
