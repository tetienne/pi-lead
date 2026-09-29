# PI Lead

A Pi package that turns one Pi session into an engineering lead. You talk in
plain language; the Lead answers questions itself, shapes ideas with
[Matt Pocock's skills](https://github.com/mattpocock/skills), and delegates
real work to workers that run in background [Herdr](https://herdr.dev) worktree
workspaces, each on the model and thinking level the Lead chooses for it.

No commands. Ask "how does the session store work?" and you get an answer.
Say "let's add CSV export" and the Lead reads Matt's own router, `ask-matt`,
grills you, then asks: spec, tickets, or implement now? A small change it
makes itself, in your session; a multi-session build becomes a spec and
tickets, one worker per ticket.

## How it works

```
you ─► Lead (Pi, your tab)
        question            → answered directly
        anything else       → ask-matt picks the flow: grill-with-docs, triage, wayfinder…
                              (in the conversation), then: spec, tickets, or implement now?
        single-session work → /implement here, in the Lead's session
        a ticket of a multi-session build, or anything you send to the background
        (implement / prototype / diagnosing-bugs / code-review / research)
                            → delegate tool
                                 the Lead picks the worker's model + thinking level (with a reason)
                                 → Herdr worktree workspace (no focus), worker Pi in it
                                 worker Pi: runs on the host, /skill:implement … as written
                                 worker pushes, opens a draft PR, gets CI green, calls finish
                                 host checks CI on the PR head (red or pending: back to the worker once)
                                 (delegate returns at once; the result comes back as a message)
        worker tool         → list workers, relay an answer to one waiting on you, stop one
        merge tool          → on your go-ahead: green PRs one at a time, each updated from base and
                              green again on its new head before it merges
        sub-agents a skill asks for (Lead or worker)
                            → a non-interactive Pi in a Herdr pane beside it
```

- The **Lead** is ordinary Pi plus a short workflow section in its system
  prompt (questions: answer; otherwise follow `ask-matt`) and three tools,
  `delegate`, `worker` and `merge`. It implements single-session work itself with
  `/implement`, delegates each ticket of a multi-session build (or anything
  you ask to run in the background), and inspects worker branches and CI
  with git and `gh` through bash. It never intercepts your messages (see
  [ADR 0001](docs/adr/0001-lead-is-a-tool-driven-conversation.md) and
  [ADR 0007](docs/adr/0007-lead-implements-workers-run-implement-as-written.md)).
- **Worker reports are untrusted.** The worker's own words reach the Lead
  inside a `<worker-report untrusted>` block, and the Lead is told to report
  them, not follow them. There is no confirmation step: a worker already runs
  on your machine with your access (see
  [ADR 0006](docs/adr/0006-no-fences-around-host-workers.md)). When the worker's
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
  through `/tdd`, then `/code-review`. There is no scout phase, no list of
  files the worker may touch and no readiness check: an approved ticket
  always starts, and a worker that finds a real gap asks you (`needs_human`).
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
  The report's status is the worker's own, capped only by this host
  evidence; other work (a prototype or a review, which opens no PR) keeps the
  worker's status.
- **Green PRs merge one at a time, and only when you say so.** Parallel
  branches merged at once break each other
  ([mattpocock/skills#493](https://github.com/mattpocock/skills/issues/493)),
  so the Lead merges with its `merge` tool, never with `gh pr merge` itself,
  and only after your go-ahead: for one PR, or once for a whole spec ("merge
  them as they turn green"). A done worker keeps its workspace open until
  its PR is merged. The Lead passes the PRs in ticket order, and each one,
  strictly after the previous one merged, is marked ready if it is a draft (`gh pr ready`;
  GitHub does not merge drafts), is brought up to date with its base (`gh pr
  update-branch`, a merge of the base into the PR branch), waits for CI on
  that new head (`gh pr checks --watch --fail-fast`, allowing a few seconds for
  checks to register), and is merged at exactly that head (`gh pr merge
  --match-head-commit <sha>`) with the method you name or else the first the
  repository allows, in gh's own order (merge commit, rebase, squash, from
  `gh repo view --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed`;
  gh itself requires a method when it cannot prompt). No `--delete-branch`:
  the remote branch follows the repository's delete-on-merge setting, and
  the local branch stays. The merged worker's workspace then closes. A
  conflict or red CI after the update goes back to that PR's worker, which
  reports again once it is fixed; the run stops there, and the Lead hears
  which PRs merged and which were not attempted. A PR whose worker is gone
  (stopped, or its Pi ended before a restart) is reported to you instead. A merge
  that a merge queue or auto-merge accepts without merging yet also stops
  the run.
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
  `○` starting, `●` running, `?` waiting for your answer, `~` partly
  done, `✗` blocked or failed, `✓` done, `-` stopped (e.g. `? Add CSV export`).
  A worker that stops and needs you also raises a Herdr notification; only a
  question plays a sound. Titles are reduced to letters, digits and plain
  punctuation, and notifications never quote the worker. The Lead's status
  line counts live workers (`● 2 running · 1 needs you`, in the warning colour
  while one waits on you), and events such as "started on…" or "ran out of
  quota…" appear as dim transcript lines that the model never sees.
  Each result shows in the Lead as a card: verdict, time, model, commits and
  diff, what CI the host checked, the branch, review hints and next steps, with every
  line the worker wrote behind a `│` gutter, marked untrusted. Expand it to
  read the full report the model received. The Lead warns at start only when
  workers cannot run (not inside Herdr, or Herdr's Pi integration missing).
  Worker workspaces need Herdr 0.9.1 or later (`worktree create`,
  `notification show`, `--seq`).
- **Workers outlive a crashed Lead.** Quitting the Lead (or `/new`,
  `/reload`) stops its workers and removes their worktrees; their branches
  stay. If the Lead's Pi crashes or is killed instead, its workers keep
  running, and the next Lead you start in the same repository adopts every
  one whose pane still runs its Pi: it shows in `worker list`, you can
  message or stop it, and its result arrives as usual, including a `finish`
  it made while no Lead was running. That includes a done worker whose PR
  still awaits its merge: it keeps its workspace, a conflict or red CI at
  merge time goes back to it, and its workspace closes once the PR merges.
  Workers whose Pi is gone are removed, branch kept; their PRs still merge
  by number or URL, with any problem reported to you. A Lead never adopts
  the workers of another Lead that is still running.
- **Tickets are sequenced by their Blocked-by edges.** Every worker starts
  at once; the Lead delegates a blocked ticket only once its blockers' PRs are
  merged, or starts it from a blocker's branch (`startFrom`) when you ask for
  stacking. Conflicts surface, and are resolved, in the one-at-a-time merge
  flow. When a finished worker's branch changes files that another worker's
  open PR changes too, its report names that ticket and the shared files.
- **Sub-agents run in Herdr panes.** When a skill asks for a sub-agent
  (code-review's two axes, grilling's fact-finding, wayfinder's research,
  improve-codebase-architecture's exploration, codebase-design), the Lead or
  worker starts a non-interactive Pi in a pane split beside it, without
  focus, waits for it and reads its report. Without Herdr, it runs those
  steps one after the other in its own context and says so.
- **The Lead picks each worker's model and thinking level.** `delegate` requires
  a `model` (`provider/model-id`), a `thinking` level (`off` to `max`) and a
  one-sentence `why`. Each prompt lists the models a worker may run on, with
  their prices (the ones your session is scoped to with `--models` or
  `enabledModels`, otherwise every model Pi has auth for) and a rule of thumb: a cheaper, faster model and low thinking for
  mechanical or single-module work, the strongest model and high thinking for
  cross-cutting, subtle or debugging work. Any other model is refused with
  that list (see
  [ADR 0008](docs/adr/0008-lead-chooses-worker-model-and-thinking.md)).
- **A worker out of quota continues on another model.** Pi never retries a
  quota error, so nothing is charged to a paid balance: the worker commits
  what it has and reports `blocked` with its branch, and its provider is
  marked exhausted in the list, and refused, until its quota resets (the time
  ChatGPT gives, at least 5 minutes; 5 minutes for a ChatGPT limit without a
  time; one hour otherwise). The Lead delegates the same ticket again at once,
  without asking you, on another provider's model with `startFrom` set to
  that branch: the new worker starts from it, pushes onto the same PR, and
  its report covers everything since the ticket's base; the old worker's
  workspace closes. A worker whose changes could not be committed stays put,
  and you hear about it.

Design record:

- [ADR 0001](docs/adr/0001-lead-is-a-tool-driven-conversation.md): the Lead is
  an ordinary Pi conversation that acts through tools.
- [ADR 0002](docs/adr/0002-bound-jev-judgments-with-policy.md): Jev's answers
  stay inside deterministic policy (superseded by ADR 0008).
- [ADR 0003](docs/adr/0003-workers-mirror-the-lead.md): workers are plain Pi,
  like the Lead; Matt's router drives the Lead.
- [ADR 0004](docs/adr/0004-verify-with-a-project-chosen-command.md): a
  host-run `verify` command (superseded by ADR 0007).
- [ADR 0005](docs/adr/0005-run-workers-on-the-host.md): workers run on the
  host, in their own git worktree.
- [ADR 0006](docs/adr/0006-no-fences-around-host-workers.md): no fences around
  host workers.
- [ADR 0007](docs/adr/0007-lead-implements-workers-run-implement-as-written.md):
  the Lead implements single-session work; one worker per ticket runs
  `/implement` as written; and the limit of these choices.
- [ADR 0008](docs/adr/0008-lead-chooses-worker-model-and-thinking.md): the
  Lead chooses each worker's model and thinking level.

## Requirements

- Pi ≥ 0.87.1 (GPT-6 Sol/Luna), Node ≥ 23.6, git.
- Herdr: start the Lead's Pi inside a Herdr pane; `herdr integration install pi`
  for worker status badges and reliable Lead → worker messages.
- The models you want workers to use, authenticated in Pi (`/login`, or the
  provider's key in the environment). Scope the session to them (`--models`,
  or `enabledModels` in Pi's settings) to keep the Lead's list short.

## Install

<!-- x-release-please-start-version -->
```bash
pi install -l git:github.com/tetienne/pi-lead@v0.9.0
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
  "keepFailedWorkers": true,
  "stuckDetection": true
}
```

Settings:

- `keepFailedWorkers` (default `true`): a worker that finishes `partial`,
  `blocked` or `needs_human` stays open, waiting for your answer; one that
  fails (it dies without `finish`) keeps its workspace while the Lead runs
  and its task directory after. With `false`, both are removed, branch kept.
- `stuckDetection` (default `true`), below.
- `reviewModel` (default unset): what `pi --model` takes (`provider/id`, with
  an optional `:thinking` suffix, e.g. `openai-codex/gpt-6-astra:high`). Only
  code-review's sub-agents (in a worker or in the Lead) run on it; every other
  sub-agent keeps Pi's default model. Unset keeps that default for all. If a
  review sub-agent fails (quota, auth, unknown model), that is reported, not
  rerouted to another model; the Lead may then delegate another review.

The Lead picks each worker's model and thinking level (above), so there is no
worker model setting. The `tiers` and `jev` blocks of older versions are ignored.

`stuckDetection` watches a worker's shell commands and file changes: when the
same command fails three times without succeeding, or six commands in a row
fail, with no file changed through its `write` or `edit` tools in between, the
worker is told once per prompt to step back or finish as `blocked`. A test-first loop (edit, tests fail, edit) never counts. It is never
stopped automatically.

### Web access for workers

Workers use your own Pi extensions (a web search extension, for example),
which they load like the Lead.

### Verification

Your project verifies its own work: its git hooks (prek, for example) run
when the worker commits, and its CI runs on the worker's draft PR, which PI
Lead checks.

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
