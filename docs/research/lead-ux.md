# Lead and worker UX: header, tabs, live view

Research date: 2026-09-24. Scope: what PI Lead shows today, what Pi 0.87.1's
extension UI and Herdr 0.9.1 let it show, and what the most used Pi subagent
extensions do. Research only; no code changed. Mockups are proposals. The
proposal below is the second version, after a skeptical review (see the
review record at the end).

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
| `pi.setSessionName(name)` | Name worker sessions after their ticket, so `/resume` in a worker tab lists `CSV export` instead of the first prompt |

Two constraints carry over from the existing code:

- **Every line must fit the width, or Pi aborts.** Pi aborts on a line wider
  than the terminal, so a width bug is fatal, not cosmetic. `jev-display.ts`
  has `safe()` and `fit()`, but neither fits the new renderers:
  - `safe()` allows only printable ASCII plus a few symbols, and turns
    anything else, emoji included, into `?`.
  - `fit()` counts code points, not columns.

  New renderers need a sanitizer that keeps multi-line text, drops zero-width
  and bidi characters, and measures columns with `visibleWidth` from
  `@earendil-works/pi-tui`. They need tests at fixed widths.
- **Worker text is untrusted.** Summaries, titles, questions and tool
  arguments come from a model, and so does `title`, which the Lead model
  writes and a tainted Lead can shape. `safePreview` (`src/report-guard.ts`)
  turns newlines into `⏎`, so it only fits one-line previews.

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

PI Lead's `describe()` already guards the presentation with `--agent pi`, but it
sends no `--seq`. Every report is fire-and-forget, so two quick reports can land
out of order, and Herdr may keep the older one. nicobailon/pi-subagents sends
`--seq Date.now()` with every report. `herdr.ts` has no `tab rename` call yet.

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

## Proposal (v2, after a skeptical review)

The first draft proposed about 25 glyphs, kind emoji, a live fleet widget with
a spinner, a replacement header, crew names and a terminal-title spinner. A
skeptical review (below) cut it down. What remains is what gives most of the
value without widening the trust surface.

### Glyphs

The set has no emoji at all:

- **Width is unreliable.** Emoji are two columns wide, and some (`✋`, `⚠`)
  are one or two depending on the Unicode table and the U+FE0F variation
  selector. Herdr, Pi and the outer terminal can each count differently, and
  Pi aborts on an over-wide line.
- **Coverage is patchy.** Emoji are missing on the Linux console and show as
  tofu over some SSH fonts.
- **Kind emoji add nothing.** They repeat what the title already says, in a
  tab that shows only ~20 columns.

Every glyph below is one column in Western locales. Each pairs a shape with a
colour, and the shape alone carries the meaning, so colour-blind users and
monochrome terminals lose nothing.

| Glyph | Meaning | Why this one | Colour |
|---|---|---|---|
| `●` | running | A full dot: something is active. It is the same shape Herdr and most sidebars use | accent |
| `○` | queued or starting | An empty dot: it will run but isn't running yet. Paired with `●`, it reads without a legend | dim |
| `?` | needs you (`needs_human`, or waiting on an answer) | A question: the worker is waiting for your answer. Plain ASCII, can't be misread as "stop" (which `✋` can) | warning |
| `✓` | done | Universal "OK" | success |
| `~` | partial | "Roughly": some criteria are met, not all. `▲` is not used, since it already means "Jev overrode" | warning |
| `✗` | blocked or failed | Universal "no". The text says which one | error |
| `-` | stopped by you or by the timeout | Neutral on purpose: it was stopped, not a failure | dim |
| `!` | host warning: sensitive files touched, a stuck worker | ASCII in place of `⚠`, whose width depends on U+FE0F | warning |
| `└` | "current activity" line under a row | `⎿` has poor font coverage, while `└` is basic box drawing | dim |
| `◆` `◇` `▲` | Jev: decided, default applied, overrode the worker | Already shipped (`jev-display.ts`), unchanged | dim |

`●`, `○` and `◆` are East Asian Ambiguous: two columns in CJK locales. The
Jev lines already accept that, and renderers must measure columns with
`visibleWidth` rather than assume one.

What makes it pleasant is typography rather than pictograms:

- bold titles;
- theme colours on the glyphs;
- the report card on Pi's `customMessageBg` background;
- short friendly working messages.

### 1. Footer: counters only

`2 running · 1 needs you · ◆ 14 · $0.004/1.00`. The `needs you` segment
uses the warning colour. `lastProgress` leaves the footer. The "started" and
"queued" messages become dim transcript entries, like the Jev lines (a custom
entry the model never sees).

### 2. Tabs and Herdr metadata

- **Tab label:** becomes `<glyph> <title>`, e.g. `● CSV export`,
  `? auth flow`, `✓ flaky login`. It is renamed on every `setState`, which
  needs a new `tab rename` call in `herdr.ts` (one more fire-and-forget
  process per state change).
- **What goes into the label:** the title passes an allowlist filter
  (letters, digits, space, `-_.:/()`) and is clipped by columns. The `lead:`
  prefix goes.
- **Every metadata report carries `--seq`.**
- **State labels are fixed host strings.** For example `working=implement ·
  sol·high`, `blocked=needs your answer`, `done=done`. They never contain
  the worker's question or summary.
- **`needs_human` notification:** `herdr notification show "<title> needs
  your answer" --sound request`, with no body taken from the worker. The
  question is read in the Lead, where the report guard applies. There is no
  notification on `done`.

### 3. Readable tool calls

`renderCall` / `renderResult` for `delegate` and `worker`. The kind is shown
as a word, and the task preview goes through `safePreview`:

```
delegate implement  CSV export
  └ Add a CSV export to the reports page…
→ standard · gpt-6-sol (high) · difficulty 2.1/4 · starting in its tab

worker list
  ● CSV export   a1b2c3d4  running 4m   sol·high
  ? auth flow    9f8e7d6c  waiting 3m   sol·high
```

### 4. Report card, which never hides the worker's words

This needs `lead.ts` to pass `outcome.details` through (today it keeps only
`{ status, worker }`, so `sensitive`, `jevVerdict` and `review` are lost) and
`settle()` to add elapsed time, commit count and diff totals.

The report guard clears its taint as soon as the user sends a message, on the
assumption that the user has seen every report (`report-guard.ts:128-138`). The
collapsed card must therefore show part of the worker's own text, labelled as
such, and never only host-picked fields:

```
✓ implement · CSV export: done in 12m · sol·high
  3 commits · +214 −37 in 9 files · tests passed (npm test)
  worker says (untrusted): Added CsvExporter and a /reports/export route;
  streaming for large reports, tests for quoting and empty reports.
  … 6 more lines (Ctrl+O)
  ! touches package.json, .github/workflows/ci.yml: review before merging
  next: work is on local branch pi-lead/csv-export-a1b2c3; nothing was pushed
```

The `next:` lines show dimmed. They are host-written and say what the Lead is
about to do. Expanded, the card shows everything the model receives. A report
stored by an older version, without the new `details`, falls back to the
current plain text.

### 5. Startup check, without replacing the header

Pi's header stays, because its keybinding hints matter to new users and only
one extension can own it. At `session_start`, a missing Herdr, a missing Herdr
Pi integration or a missing Jev key gives one `notify` warning with the fix.
`/lead-doctor` prints the full check: tiers → models, Jev, image, Herdr.

### Deferred, maybe never

- **Fleet widget with a worker heartbeat (`activity.json`).** It mostly
  repeats what Herdr and the renamed tabs already show. A spinner above the
  editor would redraw about 12 times a second over SSH, and the current tool
  argument can show secrets. If it is ever built:
  - a static `●` with elapsed time, redrawn every 5 s;
  - no tool arguments;
  - an atomic write;
  - validated fields;
  - stall hints from Herdr agent state first.
- **`/workers` overlay:** the `worker` tool already has the actions.
- **Cut:**
  - crew names: a fourth identifier after title, id and agent name;
  - the terminal-title spinner;
  - the "idle" closing line;
  - the `▣ ⇅` worker footer;
  - the `ui.emoji` / `fleet` / `crew` config matrix.
- **Kept:** worker `pi.setSessionName(title)` and friendly working messages
  (`Jev sizes up the ticket…`, `Cloning into a fresh sandbox…`), both cheap.

## Order of work

1. Footer, tab glyphs and renames, `--seq` plus fixed state labels, and the
   `needs_human` notification.
2. `renderCall` / `renderResult` for `delegate` and `worker`.
3. The report card, with `details` passed through.
4. The startup warning and `/lead-doctor`, working messages, worker session
   names.

Each step keeps rendering pure, as `jev-display.ts` does: functions from data
to width-fitted, sanitized lines, unit-tested at fixed widths. `lead.ts` and
the worker extension only wire them to Pi.

## Review record

A skeptical reviewer read the first draft against the code. What changed:

| Severity | Objection | Outcome |
|---|---|---|
| high | A collapsed card that shows only host fields lets an injected report pass: the user types "ok" and the taint clears (`report-guard.ts:128-138`) | Card always shows the worker's text, labelled untrusted |
| high | The worker's question in Herdr state labels and OS notifications puts model text in trusted-looking places | Fixed host strings only; allowlisted titles |
| high | A fleet widget with a spinner and 1 s polling repeats Herdr, redraws constantly and can show secrets | Deferred with constraints |
| high | Wrong claims: `details` already available, reusing `safe()`/`fit()`, `--applies-to-source` missing | Corrected above |
| medium | Replacing the header hides keybinding hints and duplicates existing errors | Header kept; `notify` + `/lead-doctor` |
| medium | Too many glyphs, clashing meanings (`▲`, `…`, `⚒` vs `🔨`, `✋` vs `■`) | Set of 10, no emoji |
| medium | Crew names, title spinner, config matrix are noise | Cut |

## Still to verify

- Herdr 0.9.1 `tab rename` and `notification show` on the Herdr version the
  README asks for; how many columns the tab bar gives a label.
- How `●`, `○` and `✓` render in Herdr's tab bar under a CJK locale.
- What a message renderer shows for reports stored by older versions (no new
  `details` fields): fall back to the current plain text.
