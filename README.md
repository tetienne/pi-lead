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
  branch touches files that run implicitly on your machine or in CI, or widen
  PI Lead's policy (CI workflows, `package.json`, `.npmrc`, mise and direnv
  config, git hooks, `.vscode` tasks/settings, `.pi/`…), the report adds a
  host-generated warning to review them before merging; it never blocks.
- A **worker** is an interactive Pi session in its own Herdr tab. Its
  `read/write/edit/bash/ls/find/grep` tools run inside a Gondolin micro-VM that
  mounts only a throw-away clone of the repository. The guest never sees your
  environment, credentials or checkout; provider calls stay on the host, so
  any Pi provider or subscription works. A worker is a Pi like the Lead: same
  skills, prompts and `AGENTS.md`, plus the repository's own skills when you
  trust the project, but no host-side extensions except Herdr's Pi
  integration (working/idle badges). It can search the web with `web_search`
  through your ChatGPT subscription (see
  [Web access for workers](#web-access-for-workers)). When an implement, prototype or debug
  worker finishes `done` with no recorded test run, or a failing last one,
  `finish` sends it back once to run the tests or report `partial`; the next
  `finish` goes through (`"steerUnverifiedDone": false` disables this).
- **Toolchains** come from the project's mise config: the first worker runs
  `mise install` in a sandbox into a per-project cache, later workers mount it
  read-only and start instantly. (Your Mac's own mise cache holds macOS
  binaries, which the Linux guest cannot run.)
- **Jev** answers small closed questions — difficulty, readiness, egress,
  verdict, review severity, failure kind, ticket overlap — and code maps each
  answer to an action. Without a key, documented defaults apply.

Design record: [ADR 0005](docs/adr/0005-lead-is-a-tool-driven-conversation.md),
[ADR 0006](docs/adr/0006-workers-mirror-the-lead.md) and
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
pi install -l git:github.com/tetienne/pi-lead@v0.5.0
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
  "jev": { "via": "openrouter", "dailyBudgetUsd": 1, "display": "normal" },
  "keepFailedWorkers": true,
  "leadGuard": "confirm",
  "waitingTimeoutMinutes": 120,
  "stuckDetection": true,
  "steerUnverifiedDone": true
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

### Web access for workers

Workers load no host-side extensions, so web tools installed in your own Pi
(pi-web-access, context-mode, an MCP server…) do not reach them. Two ways in
stay within the sandbox policy.

**`web_search` (built in).** Every worker has a `web_search` tool when you are
logged in to Pi with a ChatGPT subscription (`/login` → OpenAI Codex). It sends
one request with OpenAI's hosted web search through Pi's own Codex transport:
the search runs at OpenAI, nothing is fetched from your machine or the VM, and
the token never reaches the guest. It uses the worker's model when that is an
`openai-codex` model, otherwise any `openai-codex` model you are logged in to;
it never falls back to another provider (an OpenAI API key, OpenCode Go, a
gateway), and a Codex provider pointed at a host other than `chatgpt.com` is
refused. Without a Codex login the tool is hidden. The answer comes back
wrapped in `<web-search-results untrusted>` with its source URLs, and each
search counts against your ChatGPT usage. Queries do not go through the VM's
egress policy: OpenAI already sees the worker's context, but the pages its
search visits are chosen by the model, so a query written from untrusted code
can carry text to a third-party site.

**Context7 (up-to-date library docs).** [Context7](https://context7.com)'s API
is plain HTTPS GET, so allowlisting it lets workers query it without asking
Jev or you. `allowedHosts` replaces the default list, so keep the defaults:

```json
{
  "sandbox": {
    "allowedHosts": [
      "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
      "github.com", "codeload.github.com", "objects.githubusercontent.com",
      "context7.com"
    ]
  }
}
```

Then tell workers about it in the consuming project's `AGENTS.md` (workers
read the same `AGENTS.md` as the Lead):

```markdown
## Library documentation

Before using a third-party API, check its current docs with Context7:

    # find the library ID
    CTX7_TELEMETRY_DISABLED=1 npx -y ctx7 library nextjs "middleware"
    # fetch the docs for a topic
    CTX7_TELEMETRY_DISABLED=1 npx -y ctx7 docs /vercel/next.js "middleware authentication"

Without Node, the same with curl (JSON):

    curl -s "https://context7.com/api/v2/libs/search?libraryName=prisma&query=relations"
    curl -s "https://context7.com/api/v2/context?libraryId=/prisma/prisma&query=one-to-many%20relations"
```

`CTX7_TELEMETRY_DISABLED` stops the CLI's usage event, a POST that Jev would
otherwise have to judge. Queries are anonymous and rate-limited; keep your
Context7 API key out of the VM.

Then ask the Lead in plain language:

- "Research how Prisma 7 handles one-to-many relations and write it up" → a
  `research` worker reads the docs through Context7 and cites them.
- "Add rate limiting to the API with the current Hono middleware" → the
  `implement` worker checks Hono's docs before writing code.
- "Find out why `pnpm install` fails with ERR_PNPM_BAD_PM_VERSION since
  yesterday" → a `debug` worker uses `web_search` for recent reports.

`stuckDetection` watches a worker's shell commands: when the same command fails
three times in a row, or its last six commands all fail, Jev is asked whether
it is repeating a failed approach; if so the worker is told to step back, and
the second time to finish as `blocked` (with a warning in its tab). It is never
stopped automatically. Without Jev, only the same-command case counts.

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
budget and the default applied, `▲` Jev overrode the worker. Pi's expanded
view adds confidence, threshold, latency and cost. Worker tabs show their
egress and stuck-loop decisions as notifications. `/jev` lists today's calls and spend by kind
and this session's last 20 decisions.

`jev.display` sets how much shows: `normal` (default) shows every Lead
judgment, and in worker tabs every stuck-loop check and only denied or
questioned egress (allowed egress is just counted); `quiet` shows only `◇`,
`▲`, denied egress and a worker found stuck; `verbose` also shows allowed
egress.

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
