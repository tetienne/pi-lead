# Lead and worker UX: header, tabs, live view

Research date: 2026-09-24. Scope: what PI Lead shows today, what Pi 0.87.1's
extension UI and Herdr 0.9.1 let it show, and what the most used Pi subagent
extensions do. Research only; no code changed. Mockups are proposals.

## What PI Lead shows today

| Where | Today | Source |
|---|---|---|
| Lead footer | `workers: 1 running · 1 waiting for you · "CSV export" started on openai-codex/gpt-6-sol (high) · ◆ 14 · $0.004/1.00` (a single `setStatus` line; the last progress message grows without bound) | `src/lead.ts` `status()` |
| Lead header | Pi's default (logo + keybinding hints) | — |
| Lead terminal title | Pi's default | — |
| `delegate` / `worker` tool calls | Pi's default: tool name + raw JSON args; result as plain text | `src/lead.ts` `registerTool` |
| Worker result | The full text sent to the model (`Worker "…" [a1b2c3d4]: model · thinking · tier…`, `<worker-report untrusted>` tags, `Next:` instructions for the model) printed verbatim | `src/delegate.ts` `settle()`, `pi.sendMessage({ customType: "pi-lead-worker", display: true })` |
| Jev decisions | Dim one-liners `◆ jev · tier standard (difficulty 2.1/4, conf 0.82)`, expanded with confidence/latency/cost | `src/jev-display.ts` |
| Herdr tab label | `lead: CSV export` (48 chars max), fixed for the tab's life | `src/delegate.ts` `launch()` |
| Herdr pane metadata | title, display agent `pi-lead implement`, tokens `model thinking branch worker state`, `working=implement: CSV export`; no `--seq`, no `--ttl-ms`, no `--applies-to-source` | `src/delegate.ts` `describe()` |
| Herdr agent name | `lead-csv-export-a1b2` | `src/delegate.ts` `agentName()` |
| Worker footer | `Gondolin: starting`, then `Gondolin: 3f9a1c2e · pi-lead/csv-export-a1b2c3` | `src/worker/extension.ts` |
| Worker notifications | Jev egress/stuck decisions, stuck warnings | `src/worker/extension.ts` |

The problems:

- **The footer mixes counters and a log.** The last progress message sits in
  the footer until the next one, and it is too long for a footer.
- **Worker results are written for the model, not for you.** The Lead then
  paraphrases them, so the same information shows twice. The raw version has
  8-char ids, protocol tags and imperative "Next:" lines.
- **While a worker runs, the Lead shows nothing about it.** You can't see
  elapsed time, the current tool, turns, cost, context use or the last test,
  so you have to switch tabs to find out.
- **Tab labels never change.** `lead: CSV export` says nothing about kind or
  state, and a worker waiting on you looks exactly like a busy one.
- **Nothing checks the setup when the Lead starts.** A missing Herdr
  integration, Jev key or worker image only shows up at the first `delegate`.

## What Pi lets an extension draw

All from `ExtensionUIContext` in `dist/core/extensions/types.d.ts` (0.87.1).
Examples live in `examples/extensions/`.

| API | Use for PI Lead |
|---|---|
| `ui.setHeader(factory)` | Replace the startup header with a compact Lead card (and keep a way back to Pi's). `custom-header.ts` |
| `ui.setWidget(key, lines \| factory, { placement: "aboveEditor" \| "belowEditor" })` | Live fleet board. A component factory can animate (spinner) through `tui.requestRender()`. `widget-placement.ts` |
| `ui.setStatus(key, text)` | Short footer counters. Composes with other extensions (pi-powerline-footer gathers them) |
| `ui.setFooter(factory)` | Not recommended: it takes over the whole footer from the user's own choice |
| `ui.setTitle(text)` | Terminal title with a spinner and counts. `titlebar-spinner.ts`. Inside Herdr it becomes the `terminal_title` token |
| `ui.setWorkingMessage(text)` / `setWorkingIndicator` / `setHiddenThinkingLabel` | Loader text while Jev or a delegation is running. `working-indicator.ts` |
| `registerTool({ renderCall, renderResult })` | Readable `delegate` / `worker` calls; collapsed vs `Ctrl+O` expanded |
| `registerMessageRenderer(customType, renderer)` | Render `pi-lead-worker` reports as a card. **The model still receives `content` unchanged**, so the report guard and the model's context are not affected |
| `registerEntryRenderer` | Already used for Jev lines |
| `ui.custom(factory, { overlay: true })` | A `/workers` inspector overlay with keyboard input. `overlay-test.ts` |
| `ui.notify(text, level)` | Already used |
| `pi.setSessionName(name)` | Name worker sessions after their ticket, so `/resume` in a worker tab lists `🔨 CSV export` instead of the first prompt |

Two constraints carry over from the existing code:

- **Every line must fit the width.** Pi aborts on a line wider than the
  terminal. `jev-display.ts` already has `safe()` and `fit()` for this. Emoji
  are two columns wide, so width must be measured with `visibleWidth` from
  `@earendil-works/pi-tui`, not with `.length`.
- **Worker text is untrusted.** Summaries, titles and tool arguments come from
  a model and can carry terminal escapes. They must go through `safePreview`
  (`src/report-guard.ts`) or `safe()` before any renderer draws them.

## What Herdr lets a program set

From Herdr's `docs/versions/0.9.1` CLI reference, via `github.com/herdrdev/herdr`:

- **`pane report-metadata <pane> --source ID [--agent pi] [--applies-to-source herdr:pi]`**
  takes these fields:
  - `--title`, `--display-agent`
  - `--state-label STATUS=TEXT`, where STATUS is `idle`, `working`, `blocked`,
    `done` or `unknown`
  - `--token NAME=VALUE`, `--clear-token`, `--clear-state-labels`
  - `--seq N`, `--ttl-ms N`
  Text is trimmed, stripped of control characters and capped at 80 characters.
- **`tab rename <tab> <label>`** and **`pane rename`**: the tab bar is the one
  place every Herdr user sees without extra configuration.
- **`notification show <title> [--body] [--sound none|done|request]`** raises a
  toast.
- **The user configures sidebar rows and colours** (`[ui.sidebar.agents] rows`,
  with `$token` references). A program cannot set colours or icons. Custom
  tokens show only when the user's rows reference them, but the built-in
  `state_text` shows a reported state label everywhere.

PI Lead's `describe()` sends neither `--seq` nor `--ttl-ms`. Every report is
fire-and-forget, so two quick reports can land out of order, and Herdr may keep
the older one. nicobailon/pi-subagents sends `--seq Date.now()` and a TTL with
every report.

## What the popular subagent extensions do

The versions surveyed were current in September 2026. Stars and downloads are
approximate.

- **nicobailon/pi-subagents** (~3.8k★, ~100k npm/week):
  - Inline results come in two modes. `rich` shows the current tool, recent
    output, tokens, cost, duration and how fresh the activity is. `summary`
    is one stable row, e.g. `✓ reviewer · completed`.
  - FleetView widget: `2 active agents · ↓ 3.1k window · 4.2k spent · ↓/← to inspect`.
  - `/subagents-fleet` inspector: `j/k` to move, `s` steer, `D` stop, `H` open in Herdr.
  - Herdr metadata carries `⏳ 2 subagents (scout, worker) · task ⚠` as the state label and a `summary` token.
- **tintinweb/pi-subagents** (~1.2k★): the closest to Claude Code.
  - A tree widget above the editor with an 80 ms braille spinner:
    `├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s` / `│  ⎿ searching…`.
  - States: `✓` done, `■` stopped, `✗` error.
  - Coloured name badges and `@agent` mentions.
  - The footer text changes only when the counts do.
- **HazAT/pi-interactive-subagents** (~700★): each agent gets its own
  tmux/zellij/cmux pane, which is the closest model to PI Lead.
  - A boxed widget: `╭─ Subagents ── 3 running ─╮ │ 01:23 Scout: Auth  active · write 7m │`.
  - A watchdog marks a child `stalled` when its activity snapshots stop.
  - Emoji phase titles on tabs: `🔍 Investigating → 🔨 Executing: 1/3 → ✅ Done`.
  - "Sub-agent X needs help".
- **Pi's own `examples/extensions/subagent`**:
  - Results show `✓`/`✗`, the bold agent name, child tool calls as
    `→ tool args`, and collapsed / `─── Task ───` / `─── Output ───`
    sections.
  - Usage line: `3 turns ↑1.2k ↓400 R5k W1k $0.0123 ctx:12k`.
- **nicobailon/pi-messenger**: agents get memorable generated names
  (SwiftRaven), presence states and moods ("on fire", "debugging…").
- **nicobailon/pi-powerline-footer**:
  - `/vibe star trek` rewrites working messages.
  - Rainbow indicator for high thinking.
  - Context turns yellow at 70% and red at 90%.
- **Claude Code** background tasks: a `/tasks` list, a transcript on `Enter`,
  and finished rows that stay visible for a while and then leave.

What they have in common:

- **One row per agent:** a state glyph and the name, a stats line (time,
  turns, tools, tokens, context %), and a `⎿` line for the current activity.
- **Trouble is loud, success is quiet.** A worker that needs you gets a
  notification and a `⚠` or `✋`. A finished one just turns `✓`.
- **Agents are named after the task**, with an emoji for kind or phase.

## Proposal

Kind glyphs, used on tabs, rows and cards. Every emoji needs a one-column ASCII
fallback (`"ui": { "emoji": false }`):

| kind | glyph | fallback |
|---|---|---|
| implement | 🔨 | `impl` |
| prototype | 🧪 | `proto` |
| debug | 🐛 | `debug` |
| review | 🔍 | `review` |
| research | 📚 | `research` |

| state | glyph |
|---|---|
| queued | `…` |
| starting | `◌` |
| running | braille spinner `⠋⠙⠹…` (static `●` in a Herdr label) |
| waiting on you | `✋` |
| done | `✓` (success colour) |
| partial | `◐` (warning colour) |
| blocked / failed | `✗` (error colour) |
| stopped | `■` (dim) |

### 1. Tabs that say what they are doing

The label becomes `<state><kind> <title>`, kept up to date with `herdr tab rename`
on every `setState`, as `describe()` already runs on every state change:

```
 lead   ●🔨 CSV export   ✋🔍 auth flow   ✓🐛 flaky login
```

- **Label length:** drop the `lead:` prefix. Tabs already open in the Lead's
  workspace, and the prefix costs 6 of the ~20 characters a tab shows. Clip
  the title to 24 columns.
- **Herdr pane metadata:**
  - `--state-label working=🔨 sol·high · 4m`, `blocked=✋ needs you: which DB?`,
    `done=✓ done · 3 commits`.
  - Tokens `summary`, `model`, `tier`, `elapsed`, `cost`, `tests`, each capped
    at 80 characters.
  - Always send `--seq` and `--applies-to-source herdr:pi`.
- **Notifications:** `herdr notification show "✋ auth flow needs you" --body "<question>" --sound request`
  on `needs_human`, and for `partial`/`blocked` too. Nothing on `done`, since
  the Lead's card is enough. A setting can turn on `--sound done`.
- **Sidebar:** the README gets a copy-paste `[ui.sidebar.agents.rows_by_agent]`
  snippet that shows `$summary` and `$cost`.

### 2. A live fleet board above the editor

This needs a small heartbeat from the worker. The worker extension already sees
every event in its own Pi, so it writes `activity.json` into its task directory,
next to `result.json`, at most once per second:

```json
{ "seq": 41, "at": 1790000000000, "turns": 7, "tools": 23, "tool": "bash", "toolArg": "npm test",
  "tokens": 48210, "contextPercent": 41, "usd": 0.18, "lastTest": { "command": "npm test", "exitCode": 1, "at": 1789999990000 },
  "egress": { "allowed": 12, "denied": 1 }, "vm": "3f9a1c2e" }
```

The Lead polls these files every second while any worker is live and draws a
`setWidget("pi-lead-fleet", factory)` above the editor:

```
╭─ crew · 2 working · 1 needs you ─────────────────────────────── ◆ 14 · $0.004 ─╮
│ ⠹ 🔨 CSV export      sol·high   4m12  ↻7 · 23 tools · 48k (41%) · $0.18      │
│      ⎿ bash npm test   ✗ tests failing (2 min ago)                            │
│ ⠼ 📚 Postgres vs SQLite luna·med 1m03  ↻2 · 6 tools · 9k (7%) · $0.01        │
│      ⎿ read docs/adr/0004-separate-task-records-from-conversations.md        │
│ ✋ 🔍 auth flow        sol·high   waiting 3m — "Which session store?"         │
│ ✓ 🐛 flaky login      done 2m ago · 2 commits · +41 −12 · pi-lead/flaky-l…    │
╰───────────────────────────────────────────────────────────────── /workers ─╯
```

- **Row lifetime:** finished rows fade out after 30 s; waiting and failed
  rows stay.
- **Stalls:** a worker whose heartbeat stops for 3 minutes shows `stalled 3m`
  in warning colour. This is the HazAT watchdog pattern, and it is only a
  hint: stopping stays the user's call.
- **Context colour:** dim, then warning at 70%, error at 85%.
- **Narrow terminals:** drop the columns in this order: cost, tokens,
  context, branch.
- **When the board is hidden:** it is gone when no worker is live, and
  `"ui": { "fleet": "off" | "compact" | "full" }` turns it off. `compact` is one line:
  `crew ⠹🔨 CSV export 4m · ⠼📚 Postgres… 1m · ✋🔍 auth flow`.
- **Footer:** keeps only counters, which also shows up in powerline footers:
  `⚒ 2 · ✋ 1 · ◆ 14 · $0.004/1.00`. `lastProgress` leaves the footer. The
  "started" and "queued" messages become Jev-style dim transcript lines (a
  custom entry, never sent to the model).

### 3. Worker reports as cards

A `registerMessageRenderer("pi-lead-worker", …)`, fed from `details` (extended
with elapsed time, commit count, diff totals, cost, last test). The model's
`content` is untouched.

Collapsed:

```
✓ 🔨 CSV export — done in 12m · sol·high · $0.42
  3 commits · +214 −37 in 9 files · tests ✓ npm test
  branch pi-lead/csv-export-a1b2c3 (local, not pushed)
  ⚠ touches package.json, .github/workflows/ci.yml — review before merging
```

```
▲ 🔨 CSV export — partial (worker said done; Jev: criterion 2 not met) · 18m
✋ 🔍 auth flow — needs you: "Which session store should the tokens live in?"
✗ 🐛 flaky login — failed: gondolin image download timed out · kept in its tab
```

Expanded (`Ctrl+O`) adds the sanitized summary, commits, diff stat, findings and
the Jev review severity. The `Next:` lines stay model-only, since you see the
Lead act on them. The host-generated sensitive-file warning always shows, in
warning colour.

### 4. Readable tool calls

`renderCall` / `renderResult` on `delegate` and `worker`:

```
delegate 🔨 implement  CSV export
  └ Add a CSV export to the reports page (first 80 chars, dim)
→ standard tier · gpt-6-sol (high) · difficulty 2.1/4 · starting in its tab
→ queued: waits for "auth flow" (overlaps src/session/)

worker list
  ⠹ 🔨 CSV export   a1b2c3d4  running 4m   sol·high
  ✋ 🔍 auth flow    9f8e7d6c  waiting 3m   sol·high
worker message → auth flow   "Use the Redis store"   ✓ sent
```

### 5. A header that is also a health check

`setHeader` at startup in TUI mode, with `/lead-header builtin` to get Pi's
header back:

```
 π▸ lead  v0.5.0 · pi-lead@main
   crew   fast luna·med · standard sol·high · deep astra·xhigh · max 2 workers
   jev    ◆ openrouter · $0.004 of $1.00 today
   box    gondolin image ✓ 0.5.0 · mise cache ✓ · egress 2 hosts
   herdr  ✓ workspace w3 · pi integration ✓
```

Every missing piece turns into a warning line with the fix: `herdr  ✗ not inside
Herdr — workers need a Herdr pane`, `jev ◇ no key — defaults apply
(PI_LEAD_JEV_API_KEY)`, `box ◌ image downloads on first delegate (~300 MB)`.
That catches the setup problems before the first `delegate`, not at it.

### 6. Titles, loaders, and a bit of fun

- **Terminal title:** `π lead ⠹ 2⚒ 1✋ · pi-lead` via `setTitle`. It animates
  only while a worker runs. Inside Herdr it feeds `terminal_title`.
- **Working messages** while the Lead waits on something slow:
  `Jev sizes up the ticket…`, `Cloning into a fresh sandbox…`,
  `Fetching mise toolchains (first worker only)…`.
- **Worker tab:**
  - `setHeader` shows the ticket: kind, title, tier/model, branch, and the
    reminder "you are in a sandbox; typing here talks to this worker".
  - The Gondolin footer becomes `▣ vm 3f9a · ⇅ 12 ok 1 denied · tests ✗ 2m ago`.
  - `pi.setSessionName("🔨 CSV export")`.
- **Crew names (opt-in, `"ui": { "crew": true }`):** a deterministic nickname
  per worker id (`Ada`, `Grace`, `Linus`, …), shown next to the title in rows
  and tabs: `✋🔍 Grace · auth flow`. This follows pi-messenger's SwiftRaven.
  It is off by default, since it adds characters.
- **A closing line:** when the last worker settles with everything `done`, one
  dim transcript line such as `✓ crew idle · 3 done today · $1.12`. There is
  no confetti.

### 7. `/workers` inspector (later)

A `ui.custom` overlay over the fleet board:

- `j/k` moves between rows.
- `Enter` focuses the worker's Herdr tab (`herdr tab focus`).
- `m` messages the worker, `x x` stops it.
- `l` shows the tail of its session.

The same actions exist in the `worker` tool today, so this is purely UX.

## Order of work

1. **Quick wins, no new protocol:**
   - tab labels and renames;
   - `--seq`, `--applies-to-source` and state labels in `describe()`;
   - footer counters only;
   - `renderCall`/`renderResult` for `delegate` and `worker`;
   - the message renderer for reports, from `details` fields the Lead already
     has.
2. **Worker heartbeat:** `activity.json`, the fleet widget, the worker tab
   header/footer/session name, and `needs_human` notifications.
3. **Header health check, terminal title, working messages, `ui` config**
   (`emoji`, `fleet`, `crew`).
4. **`/workers` overlay.**

Each step keeps rendering pure, as `jev-display.ts` does: formatting functions
from data to lines, width-fitted and sanitized, unit-tested with fixed widths,
including emoji widths. `lead.ts` and the worker extension only wire them to Pi.

## Still to verify

- Herdr 0.9.1 `tab rename` and `notification show` on the Herdr version the
  README asks for; how many columns the tab bar gives a label; how a tab
  label renders emoji.
- Whether Pi's `visibleWidth` and Herdr agree on emoji widths in common
  terminals (Ghostty, iTerm2, WezTerm). This decides whether `emoji` defaults
  to on.
- What a message renderer shows for reports stored by older versions (no new
  `details` fields): fall back to the current plain text.
