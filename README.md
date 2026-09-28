# PI Lead

A Pi package that turns one Pi session into an engineering lead. You talk in
plain language; the Lead answers questions itself, shapes ideas with
[Matt Pocock's skills](https://github.com/mattpocock/skills), and delegates
real work to workers that run in background [Herdr](https://herdr.dev) worktree
workspaces on a model chosen by [Jev](https://docs.typesafe.ai).

No commands. Ask "how does the session store work?" and you get an answer.
Say "let's add CSV export" and the Lead reads Matt's own router, `ask-matt`,
grills you, writes a spec and tickets, then delegates each ticket.

## How it works

```
you ─► Lead (Pi, your tab)
        question            → answered directly
        anything else       → ask-matt picks the flow: grill-with-docs → to-spec → to-tickets,
                              triage, wayfinder… (in the conversation)
        implement / prototype / diagnosing-bugs / code-review / research
                            → delegate tool
                                 Jev: how hard? → model + thinking level
                                 → Herdr worktree workspace (no focus), worker Pi in it
                                 worker Pi: runs on the host, /skill:implement …
                                 worker pushes, opens a draft PR, gets CI green, calls finish
                                 Jev checks the verdict (unless the PR's CI proved it), worktree removed (branch kept)
                                 (delegate returns at once; the result comes back as a message)
        worker tool         → list workers, relay an answer to one waiting on you, stop one
```

- The **Lead** is ordinary Pi plus a short workflow section in its system
  prompt (questions: answer; otherwise follow `ask-matt`) and two tools,
  `delegate` and `worker`. It implements single-session work itself with
  `/implement`, delegates each ticket of a multi-session build (or anything
  you ask to run in the background), and inspects worker branches and CI
  with git and `gh` through bash. It never intercepts your messages.
- **Worker reports are untrusted.** The worker's own words reach the Lead
  inside a `<worker-report untrusted>` block, and the Lead is told to report
  them, not follow them. There is no confirmation step: a worker already runs
  on your machine with your access (see
  [ADR 0006](docs/adr/0006-no-lead-guard.md)). When the worker's
  branch touches files that can run on your machine or in CI, or steer future
  agents, the report adds a host-generated "Host check" line naming the
  matched patterns: CI workflows and actions, `package.json`,
  `.npmrc`/`.yarnrc`, mise, direnv, git
  hooks, `.vscode` tasks/settings, `.pi/`, `.agents/`, `.claude/`,
  `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` and `.gitmodules`. It is a hint
  to focus your review, not a security guarantee: ordinary source, tests and
  lockfiles run too once you use them, and it never blocks.
- **One worker per ticket.** An `implement` ticket goes to a single worker
  running Matt's `/implement` as written: test-first in vertical slices
  through `/tdd`, then `/code-review`. There is no scout phase and no list of
  files the worker may touch.
- **A finished ticket becomes a draft PR, opened by the worker itself.** When
  an `implement`, `debug` or `research` worker is about to finish `done`, it
  pushes its branch, opens a draft PR against the branch the ticket started
  from (titled from the ticket, reusing an existing PR for that branch), and
  waits for CI itself with `gh pr checks --watch`, fixing and re-pushing on a
  red run until it is green (or reporting `partial` if it cannot). Detached
  HEAD skips this: the worker is never asked to publish, and the work stays
  on its local branch. Once the worker calls `finish`, the host makes one
  non-watching check of the PR and its checks; a PR it cannot find, or CI
  still failing or pending, caps the report to `partial` instead of `done`.
  Checks count only on the worker's branch head: a PR whose head is another
  commit counts as pending. A report capped only because CI failed or is
  pending goes back to the same worker once, automatically, with the host's
  evidence; you hear about it only if the next report is still not `done`.
  When a PR is open and CI passed on its head (or the repository runs no
  checks), the host has proven the work and Jev's verdict is not asked; other
  work (a prototype, which opens no PR) is judged by the worker's status and
  Jev's verdict, the more pessimistic of the two.
- A **worker** is an interactive Pi session in its own Herdr worktree
  workspace (`herdr worktree create`), running directly on the host on its own
  branch; its
  `read/write/edit/bash/ls/find/grep` tools have the same network and
  filesystem access as the user running the Lead (see
  [ADR 0005](docs/adr/0005-run-workers-on-the-host.md)). A worker is plain
  Pi, like the Lead: your own global extensions (web, MCP and other tools,
  Herdr's Pi integration for working/idle badges), same skills, prompts and
  `AGENTS.md`. A worker trusts its worktree exactly when the Lead trusts the
  project: PI Lead starts it with `--approve` or `--no-approve`, for that
  process only (nothing is saved to Pi's trust store). A worker of a trusted
  project then loads the project's own extensions, skills, prompts and
  `APPEND_SYSTEM.md` from its worktree, as Pi discovers them; a worker of an
  untrusted project loads none of them. PI Lead adds only its worker
  extension and its own skills. Every Pi that PI Lead
  starts runs with `PI_LEAD_ROLE` set, and PI Lead's Lead extension stays
  inert there, so a worker never becomes a second Lead.
- **Seeing workers.** Each worker workspace's label starts with its state:
  `○` queued or starting, `●` running, `?` waiting for your answer, `~` partly
  done, `✗` blocked or failed, `✓` done, `-` stopped (e.g. `? Add CSV export`).
  A worker that stops and needs you also raises a Herdr notification; only a
  question plays a sound. Titles are reduced to letters, digits and plain
  punctuation, and notifications never quote the worker. The Lead's status
  line counts live workers (`● 2 running · 1 needs you`, in the warning colour
  while one waits on you), and events such as "started on…" or "waits for
  overlapping…" appear as dim transcript lines that the model never sees.
  Each result shows in the Lead as a card: verdict, time, model, commits and
  diff, what CI the host checked, the branch, review hints and next steps, with every
  line the worker wrote behind a `│` gutter, marked untrusted. Expand it to
  read the full report the model received. The Lead warns at start only when
  workers cannot run (not inside Herdr, or Herdr's Pi integration missing).
  Worker workspaces need Herdr 0.9.1 or later (`worktree create`,
  `notification show`, `--seq`).
- **Jev** answers small closed questions (difficulty, verdict, ticket
  overlap) and code maps each answer to an action. Without a key, documented
  defaults apply.

Design record: [ADR 0001](docs/adr/0001-lead-is-a-tool-driven-conversation.md),
[ADR 0002](docs/adr/0002-bound-jev-judgments-with-policy.md),
[ADR 0003](docs/adr/0003-workers-mirror-the-lead.md),
[ADR 0004](docs/adr/0004-verify-with-a-project-chosen-command.md) and
[ADR 0005](docs/adr/0005-run-workers-on-the-host.md).

## Requirements

- Pi ≥ 0.87.1 (GPT-6 Sol/Luna), Node ≥ 23.6, git.
- Herdr: start the Lead's Pi inside a Herdr pane; `herdr integration install pi`
  for worker status badges and reliable Lead → worker messages.
- Optional: a TypeSafe or OpenRouter key for Jev in `PI_LEAD_JEV_API_KEY`
  (exported in the shell Herdr starts panes with, so workers get it too).
  If the key is set but Jev fails (bad key, wrong model, network), PI Lead
  warns you once and falls back to its defaults. PI Lead does not track or
  cap what Jev costs; your TypeSafe or OpenRouter account does.

## Install

<!-- x-release-please-start-version -->
```bash
pi install -l git:github.com/tetienne/pi-lead@v0.7.0
```
<!-- x-release-please-end -->

## Configure

Two files, both optional:

- `~/.pi/agent/pi-lead.json` (global).
- `.pi/pi-lead.json` in the project: overrides the global file, key by key.
  It is read only when Pi trusts the project.

Pi trusts a project on its own when nothing in it needs trust: its `.pi` holds
only `pi-lead.json` and there is no `.agents/skills` in it or a parent folder.
Otherwise (`.pi/settings.json`, `.pi/extensions`, `.pi/skills`, prompts,
`.agents/skills` and similar) Pi asks at startup, unless a saved decision or
`defaultProjectTrust` decides, and print and RPC modes never ask. To trust it
later, run `/trust` and restart Pi, or start Pi with `--approve` for one run
(see Pi's `docs/security.md`). The
project file of an untrusted project is ignored, with a warning when the
session starts.

A global file, for example:

```json
{
  "tiers": {
    "fast":     { "model": "openai-codex/gpt-6-luna", "thinking": "medium",
                  "fallbacks": [{ "model": "opencode-go/deepseek-v4.1-flash", "thinking": "high" }] },
    "standard": { "model": "openai-codex/gpt-6-sol", "thinking": "high",
                  "fallbacks": [{ "model": "opencode-go/glm-5.3", "thinking": "high" }] },
    "deep":     { "model": "openai-codex/gpt-6-astra", "thinking": "xhigh",
                  "fallbacks": [{ "model": "opencode-go/deepseek-v4-pro", "thinking": "max" }] }
  },
  "jev": { "via": "openrouter" },
  "keepFailedWorkers": true,
  "stuckDetection": true
}
```

Jev's difficulty score picks the tier (below 1.5 `fast`, below 2.8 `standard`,
otherwise `deep`; debug and review start at `standard`). The first available
of `model` and its `fallbacks` runs the worker. A model is available when its
provider has auth. When none is available the Lead's model runs it. A worker
whose provider runs out of quota continues on the next available model, from
its branch. That provider is skipped until its quota resets: the time ChatGPT
gives (at least 5 minutes), 5 minutes for a ChatGPT limit without a time, one
hour otherwise. A worker whose changes could not be committed stays put. With
nothing left, the worker reports `blocked`. Pi never retries a quota error, so nothing is charged to a
paid balance. A tier without `model` uses the Lead's current model with that tier's
thinking level.

`stuckDetection` watches a worker's shell commands and file changes: when the
same command fails three times without succeeding, or six commands in a row
fail, with no file changed through its `write` or `edit` tools in between, the
worker is told once per prompt to step back or finish as `blocked`. A test-first loop (edit, tests fail, edit) never counts. It is never
stopped automatically, and Jev is not involved.

### Web access for workers

Workers use your own Pi extensions (a web search extension, for example),
which they load like the Lead.

### Verification

Your project verifies its own work: its git hooks (prek, for example) run
when the worker commits, and its CI runs on the worker's draft PR, which PI
Lead checks.

### Seeing Jev

With a Jev key set, each judgment the Lead makes gets one dim line in the
transcript, which the model never sees:

```
◆ jev · tier standard (difficulty 2.1/4, conf 0.82)
◇ jev · overlap unsure → waits
▲ jev · verdict done → partial (criterion 2 not met)
```

`◆` Jev decided and its answer applied, `◇` Jev was unsure or failing and the
default applied, `▲` Jev overrode the worker. Lines stored by older versions
still render as they were written.

## Develop

```bash
npm install
npm test
npm run typecheck
```

## Release

Versions come from [Conventional Commits](https://www.conventionalcommits.org)
on `main` (`fix:` → patch, `feat:` → minor, `feat!:` → minor while in 0.x).
[Release Please](https://github.com/googleapis/release-please) keeps a
`chore(main): release X.Y.Z` pull request up to date with the bumped
`package.json`, `package-lock.json`, this README and `CHANGELOG.md`. Merging it
tags `vX.Y.Z` and publishes the GitHub release; never tag or bump by hand.
Squash-merged pull requests need a conventional title.

The previous implementation (micro-VM-isolated workers, ChatGPT-only, task
journals) predates [ADR 0005](docs/adr/0005-run-workers-on-the-host.md) and remains in git history.

## License

[MIT](LICENSE) © Thibaut Etienne
