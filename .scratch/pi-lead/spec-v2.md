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

`delegate` returns the worker's summary, local branch, commits, diff stat,
Jev's verdict and a "Next" section. Nothing is pushed or merged.

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
| after failure | transient / environment / task bug / needs info | one automatic retry when transient | report |
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
- The host only `git fetch`es the worker branch from the clone; it never runs
  git inside the guest-writable directory.

## Toolchains

`mise install` runs once per project and mise configuration in a warm-up VM
(egress: mise's download hosts, then Jev, then the human in the Lead), into
`~/.pi/agent/pi-lead/toolchains/<project>`. Workers mount it read-only.

## Configuration

`~/.pi/agent/pi-lead.json`, overridden by `.pi/pi-lead.json` in trusted
projects: `tiers.{fast,standard,deep}.{model,thinking}`, `maxWorkers`,
`sandbox.{image,allowedHosts,memory,cpus}`, `jev.{apiKeyEnv,via,model,
dailyBudgetUsd,minConfidence}`, `keepFailedWorkers`.

## Known limits / follow-ups

1. The Debian image and the mise warm-up have not been run end to end yet
   (the development sandbox has no Docker and blocks the Alpine CDN).
2. The Lead cannot yet send a message to a running worker (for example the
   answer to a `needs_human` question); Herdr's `agent prompt` is the
   candidate.
3. The Lead itself still runs Pi's tools on the host (it writes specs and
   tickets); optionally sandbox it with the same tools.
4. Jev thresholds are defaults, not calibrated; collect real judgments and tune.
