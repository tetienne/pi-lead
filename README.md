# PI Lead

A Pi package that turns one Pi session into an engineering lead. You talk in
plain language; the Lead answers questions itself and delegates real work to
workers that run in background [Herdr](https://herdr.dev) worktree
workspaces. For fuzzy work it can shape ideas with
[Matt Pocock's skills](https://github.com/mattpocock/skills) first.

No commands. Ask "how does the session store work?" and you get an answer.
Say "fix the off-by-one in the CSV export" and a worker starts on it. Say
"let's rethink exports" and the Lead reads Matt's router, `ask-matt`, grills
you, writes a spec and tickets, then delegates each ticket.

## How it works

```
you ─► Lead (Pi, your tab)
        question               → answered directly
        clear, scoped change   → delegate (kind implement)
        fuzzy or large work    → ask-matt as a map: grill-with-docs → to-spec → to-tickets…
        implement / prototype / diagnosing-bugs / code-review / research
                               → delegate tool, tier fast | standard | deep (default standard)
                                    → Herdr worktree workspace (no focus), worker Pi in it
                                    worker: /skill:implement …, commits
                                    review tool: independent model, fresh context
                                    fixes findings (at most 2 re-reviews, else blocked)
                                    pushes, opens a draft PR, gets CI green, calls finish
                                    worktree removed (branch kept)
                                 (delegate returns at once; the result comes back as a message)
        worker tool            → list workers, relay an answer to one waiting on you, stop one
```

- The **Lead** is ordinary Pi plus a short workflow section in its system
  prompt and two tools, `delegate` and `worker`. It never intercepts your
  messages. It picks the worker's `tier` itself: `fast` for a mechanical or
  single-module change, `deep` for cross-cutting, subtle or debugging work,
  `standard` otherwise.
- A **worker** is an interactive Pi session in its own Herdr worktree
  workspace (`herdr worktree create`), on its own branch, running directly on
  the host with the same network and filesystem access as you (see
  [ADR 0005](docs/adr/0005-run-workers-on-the-host.md)). It is a Pi like the
  Lead: same global extensions and packages (Herdr's Pi integration,
  context-mode, Ponytail…), skills, prompts and `AGENTS.md`. When you trust
  the project, the worker starts with `--approve` and also loads its project
  resources (`.pi/settings.json` packages, `.pi/extensions`, skills, prompts);
  a fresh worktree has no `.pi/git` or `.pi/npm`, so each worker installs the
  project packages again at startup. PI Lead's Lead extension turns itself off
  in a worker.
- **Implement and debug workers get an independent review.** Their `review`
  tool runs `/skill:code-review` in a fresh one-shot Pi on the `tiers.review`
  model, against the ticket's base. Without `tiers.review` it runs on the
  `standard` tier's route, possibly the worker's own model: the Lead is told
  when it does. The worker fixes the findings and asks
  for a re-review; `finish done` is refused until a review covers the current
  HEAD. After three review calls (a failed reviewer run counts), remaining
  findings make the worker finish `blocked` (see
  [ADR 0006](docs/adr/0006-workers-get-an-independent-review.md)).
- **A finished ticket becomes a draft PR, opened by the worker itself.** An
  `implement`, `debug` or `research` worker pushes its branch, opens a draft
  PR against the branch the ticket started from, and waits for CI with
  `gh pr checks --watch`, fixing and re-pushing until it is green (or
  reporting `partial`). Detached HEAD skips this. After `finish`, the host
  checks the PR once; a missing PR or CI still failing or pending caps the
  report to `partial`.
- **Worker reports are untrusted.** The Lead reports and weighs them but never
  follows instructions inside them. When a branch touches files that can run
  on your machine or in CI, or steer future agents (CI workflows,
  `package.json` scripts, `.npmrc`, mise, direnv, git hooks, `.vscode`,
  `.pi/`, `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `.gitmodules`),
  the report names them. It is a hint for your review, not a guarantee.
- **Seeing workers.** Each worker workspace's label starts with its state:
  `○` queued or starting, `●` running, `?` waiting for your answer, `~` partly
  done, `✗` blocked or failed, `✓` done, `-` stopped. A worker that needs you
  raises a Herdr notification. The Lead's status line counts live workers
  (`● 2 running · 1 needs you`). Each result shows as a card: verdict, time,
  model, commits and diff, branch, review hints and next steps, with the
  worker's own words behind a `│` gutter. The Lead warns at start only when
  workers cannot run (not inside Herdr, or Herdr's Pi integration missing).

Design record: [ADR 0001](docs/adr/0001-lead-is-a-tool-driven-conversation.md),
[ADR 0003](docs/adr/0003-workers-mirror-the-lead.md),
[ADR 0005](docs/adr/0005-run-workers-on-the-host.md) and
[ADR 0006](docs/adr/0006-workers-get-an-independent-review.md).

## Requirements

- Pi ≥ 0.87.1, Node ≥ 23.6, git, `gh`.
- Herdr 0.9.1 or later: start the Lead's Pi inside a Herdr pane, and run
  `herdr integration install pi` for worker badges and Lead → worker messages.

## Install

<!-- x-release-please-start-version -->
```bash
pi install -l git:github.com/tetienne/pi-lead@v0.7.0
```
<!-- x-release-please-end -->

## Configure

Two files, both optional: `~/.pi/agent/pi-lead.json` (global) and
`.pi/pi-lead.json` in the project, which overrides the global one key by key
and is read only when Pi trusts the project (`/trust` and restart, or
`--approve` for one run; see Pi's `docs/security.md`). An ignored project file
is reported when the session starts.

```json
{
  "tiers": {
    "fast":     { "model": "openai-codex/gpt-6-luna", "thinking": "medium",
                  "fallbacks": [{ "model": "opencode-go/deepseek-v4.1-flash", "thinking": "high" }] },
    "standard": { "model": "openai-codex/gpt-6-sol", "thinking": "high",
                  "fallbacks": [{ "model": "opencode-go/glm-5.3", "thinking": "high" }] },
    "deep":     { "model": "openai-codex/gpt-6-astra", "thinking": "xhigh",
                  "fallbacks": [{ "model": "opencode-go/deepseek-v4-pro", "thinking": "max" }] },
    "review":   { "model": "opencode-go/deepseek-v4.1-flash", "thinking": "high",
                  "fallbacks": [{ "model": "opencode-go/glm-5.3-flash" }] }
  },
  "keepFailedWorkers": true,
  "waitingTimeoutMinutes": 120
}
```

The first available of a tier's `model` and its `fallbacks` runs the worker; a
model is available when its provider has auth. A tier without `model` uses the
Lead's current model with that tier's thinking level. `review` routes the
review tool; without it, reviews take the `standard` tier's route (its model,
else the Lead's), which may be the worker's own model. Pick a review model from
another family than your worker models: an independent review is the point.

A worker whose provider runs out of quota continues on the next available
model, from its branch; that provider is skipped until its quota resets (the
time ChatGPT gives, at least 5 minutes, otherwise one hour). With nothing
left, the worker reports `blocked`. `waitingTimeoutMinutes` stops a worker
that waits on your answer that long (0 disables); `keepFailedWorkers` keeps a
failed worker's workspace while the Lead runs.

### Web access for workers

Workers load your global extensions and packages, so a web or docs tool
installed globally (context-mode, `@upstash/context7-pi`…) reaches them. One
declared only in a project's `.pi/settings.json` does not: install it
globally, or tell workers in `AGENTS.md` to use a CLI such as
`npx -y ctx7 docs /vercel/next.js "middleware"`.

Every worker also has a built-in `web_search` tool when you are logged in to
Pi with a ChatGPT subscription (`/login` → OpenAI Codex). It runs OpenAI's
hosted web search through Pi's Codex transport, never another provider, and
counts against your ChatGPT usage. Its answer comes back marked untrusted,
with source URLs.

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
