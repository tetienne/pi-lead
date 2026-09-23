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
  `"leadGuard": "off"` in the global config to disable it.
- A **worker** is an interactive Pi session in its own Herdr tab. Its
  `read/write/edit/bash/ls/find/grep` tools run inside a Gondolin micro-VM that
  mounts only a throw-away clone of the repository. The guest never sees your
  environment, credentials or checkout; provider calls stay on the host, so
  any Pi provider or subscription works. A worker is a Pi like the Lead: same
  skills, prompts and `AGENTS.md`, plus the repository's own skills when you
  trust the project, but no host-side extensions except Herdr's Pi
  integration (working/idle badges).
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

- Pi 0.86.x, Node ≥ 23.6 (Gondolin), git, QEMU (`brew install qemu`).
- Herdr: start the Lead's Pi inside a Herdr pane; `herdr integration install pi`
  for worker status badges and reliable Lead → worker messages.
- A Gondolin image with git and mise, built once (Docker or Podman):

  ```bash
  npm run sandbox:image              # Debian (glibc) + git + mise → pi-lead:latest
  npm run sandbox:image -- --alpine  # without Docker; musl, fewer prebuilt mise tools
  npm run sandbox:smoke              # boots a VM and checks the isolation claims
  ```

- Optional: a TypeSafe or OpenRouter key for Jev in `PI_LEAD_JEV_API_KEY`
  (exported in the shell Herdr starts panes with, so workers get it too).

## Install

```bash
pi install -l git:github.com/tetienne/pi-lead@v0.2.0
```

## Configure

`~/.pi/agent/pi-lead.json` (a trusted project can override it in
`.pi/pi-lead.json`). Only `sandbox.image` is required in practice: Gondolin's
default image has no git, so workers refuse to start without the image built
above. Everything else is optional:

```json
{
  "tiers": {
    "fast":     { "model": "openai-codex/gpt-5.6-mini", "thinking": "low" },
    "standard": { "thinking": "medium" },
    "deep":     { "model": "anthropic/claude-opus-5-5", "thinking": "high" }
  },
  "maxWorkers": 2,
  "sandbox": { "image": "pi-lead:latest", "allowedHosts": ["registry.npmjs.org", "*.crates.io"] },
  "jev": { "via": "openrouter", "dailyBudgetUsd": 1 },
  "keepFailedWorkers": true,
  "leadGuard": "confirm"
}
```

A tier without `model` uses the Lead's current model with that tier's
thinking level. `allowedHosts` are trusted for downloads only (GET/HEAD and
git fetch); any other request, including uploads to an allowlisted host, is
judged by Jev per path, and when Jev is unsure the worker tab asks you.

## Develop

```bash
npm install
npm test
npm run typecheck
```

The previous implementation (Gondolin-hosted Pi, ChatGPT-only workers, task
journals) is in git history before ADR 0005; its research notes under
`docs/research/` remain valid references.
