# PI Lead

A Pi package that turns one Pi session into an engineering lead. You talk in
plain language; the Lead answers questions itself, shapes ideas with
[Matt Pocock's skills](https://github.com/mattpocock/skills), and delegates
real work to sandboxed workers that run in background [Herdr](https://herdr.dev)
tabs on a model chosen by [Jev](https://docs.typesafe.ai).

No commands. Ask "how does the session store work?" and you get an answer.
Say "let's add CSV export" and the Lead reads Matt's own router, `ask-matt`,
grills you, writes a spec and tickets, then delegates each ready ticket.

## How it works

```
you ─► Lead (Pi, your tab)
        question            → answered directly
        anything else       → ask-matt picks the flow: grill-with-docs → to-spec → to-tickets,
                              triage, wayfinder… (in the conversation)
        implement / prototype / diagnosing-bugs / code-review / research
                            → delegate tool
                                 Jev: ticket ready? how hard? → model + thinking level
                                 disposable git clone, project mise toolchains (cached)
                                 → Herdr tab (no focus)
                                 worker Pi: tools inside a Gondolin VM, /skill:implement …
                                 Jev guards egress; worker calls finish
                                 branch fetched back, Jev checks the verdict, tab closed
                                 (delegate returns at once; the result comes back as a message)
        worker tool         → list workers, relay an answer to one waiting on you, stop one
```

- The **Lead** is ordinary Pi plus a short workflow section in its system
  prompt (questions: answer; otherwise follow `ask-matt`) and one tool,
  `delegate`. It never intercepts your messages.
- **Worker reports are untrusted.** From the moment one reaches the Lead until
  you reply, every Lead tool call that can execute or write on your machine
  (bash, write, edit…) asks you first, and is blocked without a UI. Set
  `"leadGuard": "off"` in the global config to disable it. When the fetched
  branch touches files that can run on your machine or in CI, or steer future
  agents, the report adds a host-generated "Host check" line naming the
  matched patterns: CI workflows and actions, `package.json` (only when its
  `scripts` or `packageManager` change), `.npmrc`/`.yarnrc`, mise, direnv, git
  hooks, `.vscode` tasks/settings, `.pi/`, `.agents/`, `.claude/`,
  `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` and `.gitmodules`. It is a hint
  to focus your review, not a security guarantee: ordinary source, tests and
  lockfiles run too once you use them, and it never blocks.
- A **worker** is an interactive Pi session in its own Herdr tab. Its
  `read/write/edit/bash/ls/find/grep` tools run inside a Gondolin micro-VM that
  mounts only a throw-away clone of the repository. The guest never sees your
  environment, credentials or checkout; provider calls stay on the host, so
  any Pi provider or subscription works. A worker is a Pi like the Lead: same
  skills, prompts and `AGENTS.md`, plus the repository's own skills when you
  trust the project, but no host-side extensions except Herdr's Pi
  integration (working/idle badges). When the project names a `verify`
  command, PI Lead runs it itself when code work finishes (see
  [Verify](#verify)).
- **Seeing workers.** Each worker tab's label starts with its state:
  `○` queued or starting, `●` running, `?` waiting for your answer, `~` partly
  done, `✗` blocked or failed, `✓` done, `-` stopped (e.g. `? Add CSV export`).
  A worker that stops and needs you also raises a Herdr notification; only a
  question plays a sound. Titles are reduced to letters, digits and plain
  punctuation, and notifications never quote the worker. The Lead's status
  line counts live workers (`● 2 running · 1 needs you`, in the warning colour
  while one waits on you), and events such as "started on…" or "waits for a
  free worker slot" appear as dim transcript lines that the model never sees.
  Tab glyphs, state labels and notifications need Herdr 0.9.1 or later
  (`tab rename`, `notification show`, `--seq`); on an older Herdr, tabs keep
  their plain title and the pane keeps its title, tokens and working label.
- **Toolchains** come from the project's mise config: the first worker runs
  `mise install` in a sandbox into a per-project cache, later workers mount it
  read-only and start instantly. (Your Mac's own mise cache holds macOS
  binaries, which the Linux guest cannot run.)
- **Jev** answers small closed questions — difficulty, readiness, egress,
  verdict, review severity, failure kind, ticket overlap — and code maps each
  answer to an action. Without a key, documented defaults apply.

Design record: [ADR 0005](docs/adr/0005-lead-is-a-tool-driven-conversation.md),
[ADR 0006](docs/adr/0006-workers-mirror-the-lead.md),
[ADR 0007](docs/adr/0007-verify-with-a-host-chosen-command.md) and
[spec v2](.scratch/pi-lead/spec-v2.md).

## Requirements

- Pi ≥ 0.87.1 (GPT-6 Sol/Luna), Node ≥ 23.6 (Gondolin), git, QEMU (`brew install qemu`).
- Herdr: start the Lead's Pi inside a Herdr pane; `herdr integration install pi`
  for worker status badges and reliable Lead → worker messages.
- Nothing to build: each release carries the worker image (Debian + git +
  mise, x86_64 and arm64). The first worker downloads the one of the installed
  version (a few hundred MB, sha256-checked) into Gondolin's image store.

- Optional: a TypeSafe or OpenRouter key for Jev in `PI_LEAD_JEV_API_KEY`
  (exported in the shell Herdr starts panes with, so workers get it too).
  If the key is set but Jev fails (bad key, wrong model, network) or its daily
  budget is spent, PI Lead warns you once and falls back to its defaults.

## Install

<!-- x-release-please-start-version -->
```bash
pi install -l git:github.com/tetienne/pi-lead@v0.6.0
```
<!-- x-release-please-end -->

## Configure

`~/.pi/agent/pi-lead.json` (a trusted project can override it in
`.pi/pi-lead.json`). Everything is optional:

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
  "maxWorkers": 2,
  "sandbox": { "allowedHosts": ["registry.npmjs.org", "*.crates.io"] },
  "jev": { "via": "openrouter", "dailyBudgetUsd": 1 },
  "keepFailedWorkers": true,
  "leadGuard": "confirm",
  "waitingTimeoutMinutes": 120,
  "stuckDetection": true,
  "verifyTimeoutMinutes": 15
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
thinking level. The example is the ChatGPT Pro + OpenCode Go mapping from
[worker-models.md](docs/research/worker-models.md).

`sandbox.image` replaces the released image with a Gondolin image of your own;
it needs git and mise. From a clone of this repository:

```bash
npm run sandbox:image              # Debian (glibc) + git + mise → pi-lead:latest (Docker or Podman)
npm run sandbox:image -- --alpine  # without Docker; musl, fewer prebuilt mise tools
npm run sandbox:smoke              # boots a VM and checks the isolation claims
```

`allowedHosts` are trusted for downloads only (GET/HEAD and git fetch); any other request, including uploads to an allowlisted host, is
judged by Jev per path, and when Jev is unsure the worker tab asks you.

`stuckDetection` watches a worker's shell commands and file changes: when the
same command fails three times without succeeding, or six commands in a row
fail, with no file changed through its `write` or `edit` tools in between, the
worker is told once per prompt to step back or finish as `blocked`. A test-first loop (edit, tests fail, edit) never counts. It is never
stopped automatically, and Jev is not involved.

### Verify

A trusted project names the command that proves its work in
`.pi/pi-lead.json` (only there: the global config and untrusted projects
cannot set it):

```json
{ "verify": "npm run typecheck && npm test" }
```

When an implement, prototype or debug worker calls `finish` with `done` or
`partial`, PI Lead's worker extension (host-side code, not the model) commits
what is left, then runs `verify` in the worker's VM at `/workspace`, with the
bash tool's shell and environment, for at most `verifyTimeoutMinutes`. A
non-zero exit (or a timeout) makes the result at most `partial`, whatever the
worker or Jev says. The report states the command and exit code; the output's
tail sits in the untrusted worker block and goes to Jev's verdict. Without
`verify`, the report says the work is unverified.

The worker controls the repository, so it can change what `verify` runs (a
`package.json` script, a test file): `verify` catches honest mistakes, and the
sensitive-path review hint (changed `package.json` scripts, CI, `.pi` and
similar) points at the dishonest ones. Review both before merging.

### Seeing Jev

With a Jev key set, the Lead's status line carries `◆ 14 · $0.004/1.00`: Jev
calls today across the Lead and every worker, and spend against
`dailyBudgetUsd` (dim, then warning from 80%, error once spent). Each judgment
the Lead makes gets one dim line in the transcript, which the model never sees:

```
◆ jev · tier standard (difficulty 2.1/4, conf 0.82)
◇ jev · overlap unsure → waits
▲ jev · verdict done → partial (criterion 2 not met)
```

`◆` Jev decided and its answer applied, `◇` Jev was unsure, failing or over
budget and the default applied, `▲` Jev overrode the worker. Worker tabs
notify only egress Jev denied or put to you; allowed egress is just counted.
`/jev` lists today's calls and spend by kind and this session's last 20
decisions.

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

The previous implementation (Gondolin-hosted Pi, ChatGPT-only workers, task
journals) is in git history before ADR 0005; its research notes under
`docs/research/` remain valid references.

## License

[MIT](LICENSE) © Thibaut Etienne
