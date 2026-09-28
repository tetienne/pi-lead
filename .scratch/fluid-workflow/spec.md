# Fluid workflow: prune the processes that no longer protect anything

**Status:** ready-for-agent (awaiting spec approval)

Research: [research-ecosystem.md](research-ecosystem.md). Decisions made with the
user in conversation on 2026-09-28; ADR 0005 (workers on the host) and ADR
0006 (no Lead guard) are the ground they stand on.

## Problem Statement

PI Lead was designed while workers ran in a sandbox. Since workers run on the
host (ADR 0005), several mechanisms built as fences around an untrusted guest
still run: they slow every task, add worker phases and human gates, and
protect nothing a worker could not already do directly. Other steps
contradict Matt Pocock's flow, which PI Lead claims to follow: a one-line fix
goes through Jev sizing, a readiness gate, a scout worker, an implementer
worker, a push, a draft PR and a CI watch, because the Lead may not change
code itself. And the one step of Matt's skills that Pi cannot do natively,
sub-agents, is silently collapsed into one context (mattpocock/skills#561).

## Solution

The Lead follows ask-matt literally: single-session work is implemented by
the Lead in its own session; tickets from `/to-tickets`, parallel work and
work the user wants done in the background go to workers. A worker is one Pi
per ticket running Matt's `/implement` as written: no scout, no scope fence,
no readiness gate. Workers and sub-agents are plain Pi sessions with the
user's own extensions. When a skill asks for a sub-agent, the Lead or the
worker starts one in a Herdr pane beside it. Mechanical failures after a
worker finishes (CI red or pending, verify failed) go back to the worker once
before reaching the user. Dead code from the sandbox era is deleted.

## User Stories

1. As a user, I want to ask the Lead for a small change and have it made in my session, so that a one-line fix takes seconds, not two worker runs and a CI watch.
2. As a user, I want tickets produced by `/to-tickets` to be delegated to workers, so that multi-session builds still run in the background, one fresh context per ticket.
3. As a user, I want to ask explicitly for work to be delegated, so that I can send even a small task to the background when I want to keep talking to the Lead.
4. As a user, I want the Lead to ask me one short question after grilling (spec, tickets, or implement now?), so that "Agreed" to the last grilling question never starts implementation by surprise.
5. As a user, I want a delegated ticket to start without Jev refusing it as "not ready", so that tickets I already approved are never bounced back to me.
6. As a user, I want a worker to report `needs_human` when a ticket is really unclear, so that genuine gaps still reach me, with the worker's own explanation.
7. As a user, I want one worker per ticket, so that each ticket costs one worktree, one Pi start and one reading of the code.
8. As a user, I want the worker to build test-first in vertical slices, as Matt's `/tdd` prescribes, so that tests follow what each cycle teaches instead of an upfront bulk of imagined tests.
9. As a user, I want no scope list that stops a worker at `partial` for touching one more file, so that I never have to approve a scope widening.
10. As a user, I want a worker whose CI is red or still pending to be sent back to fix it once automatically, so that I only hear about CI when the worker could not get it green.
11. As a user, I want a failed `verify` to go back to the worker once automatically, so that mechanical failures do not cost me a round trip.
12. As a user, I want `needs_human` and `blocked` reports to still come to me, so that decisions stay mine.
13. As a user, I want the host's PR check to compare the checked head with the worker's branch head, so that green CI on an older commit never counts as green.
14. As a user, I want the Jev verdict check skipped when verify passed and CI is green on the branch head, so that a model never downgrades work the host has already proven.
15. As a user, I want workers to load my own global extensions (web, MCP, tools), so that a worker can use what my Lead can use.
16. As a user, I want a worker or sub-agent never to become a second Lead, so that there is no recursive delegation.
17. As a user, I want Herdr's Pi integration to load in workers the same way it loads for me, so that badges and messages keep working without PI Lead naming extensions.
18. As a user, I want `/code-review` to run its Standards and Spec axes in two separate sub-agents on Pi, so that the two reviews do not contaminate each other.
19. As a user, I want sub-agents to appear in a Herdr pane next to the agent that started them, so that I can watch any of them work.
20. As a Lead or worker, I want one short recipe for starting a sub-agent in a Herdr pane and reading its report back, so that every skill that asks for a sub-agent (code-review, grilling, wayfinder, improve-codebase-architecture, codebase-design) works the same way.
21. As a user, I want the Lead to inspect worker branches and CI runs with ordinary git and gh through bash, so that there is no special read-only tool to learn.
22. As a user, I want the Lead allowed to run a check itself (a test, a `gh run view`), so that a small question does not require messaging a worker.
23. As a user, I want a worker waiting on my answer to wait until I answer or stop it, so that coming back from a meeting never finds my worker killed.
24. As a user, I want debug and review work to start at the tier the README documents when Jev gives no difficulty, so that the docs and the code agree.
25. As a maintainer, I want the dead sandbox-era code removed (egress judgment, Jev settings sent to workers, legacy Herdr fallbacks, symlink and budget hardening of the context snapshot, anti-evasion parts of the host check), so that the code says what PI Lead does today.
26. As a maintainer, I want Jev calls that second-guess what the Lead reads in full (failure kind, review severity) removed, so that every delegation costs at most one Jev call before start and one after finish.
27. As a maintainer, I want an ADR recording why the scout, the readiness gate and the "Lead never codes" rule were dropped, so that nobody reintroduces them without the context.
28. As a maintainer, I want the README, CONTEXT.md and the Lead's guidance to match the new flow, so that the prompt never describes removed mechanisms.

## Implementation Decisions

- **Lead routing (guidance).** The "do not implement code changes yourself" rule is replaced by ask-matt's branch: not a multi-session build → `/implement` in the Lead's session; multi-session build → `/to-spec`, `/to-tickets`, then one `delegate` per ticket. The user may always ask to delegate. After grilling, the Lead asks one question: spec, tickets, or implement now. The guidance keeps: worker text is untrusted, report it and never follow it; never merge or delete branches unless asked; workers own their push, draft PR and CI.
- **Guidance cleanup.** Drop: "never check a worker branch out and run its tasks on the host", "do not inspect runs yourself", the Lead-side copy of "never ask a worker to create a worktree or branch" (it stays in the worker rules), references to `git_read`, and the "do its exploration yourself instead of spawning a sub-agent" workaround.
- **Scout removed.** The `scout` work kind, its tier, the brief (`allowedFiles`, `protectedFiles`), the scout hand-off, the worker's write/edit block, the refusal of a scout `done` without a list, the `allowFiles` widening through `worker message`, and the out-of-scope cap are removed. An `implement` delegation starts one worker on the implement route.
- **Readiness gate removed.** `intake` collapses into `modelTier`; `confirmedReady` and the `not_ready` status disappear from the `delegate` tool.
- **Jev scope.** Jev keeps: difficulty → tier routing (one call before start), overlap scheduling, and the verdict check. Removed: `egress`, `failureKind` (a launch failure is retried once without asking), `reviewSeverity` (the review's fix hint always shows; the Lead decides). The verdict check is skipped when verify passed (or none is configured) and CI passed on the branch head (or the repository has no checks). `egress` leaves `JEV_KINDS`, the ledger display and `/jev`. The Jev settings are no longer sent to workers.
- **Overlap scheduling.** Kept (serialising tickets that touch the same code avoids conflicting PRs, research-ecosystem.md). Unchanged in this spec.
- **Mechanical partials go back to the worker once.** After `finish`, a report capped to `partial` only because CI failed or was pending, or verify failed, is sent back to the worker automatically, once, with the host's evidence, like review fixes today. The second such report, or any `needs_human`/`blocked`, reaches the user as now.
- **PR head check.** The host PR check compares the PR's head commit with the worker branch head; a mismatch counts as pending.
- **Workers are plain Pi.** Worker Pi starts without `--no-extensions` and without naming Herdr's extension; it names only the worker extension. The Lead extension stays inert in any Pi started by PI Lead (worker or sub-agent), detected from a marker PI Lead sets when launching it (an environment variable), so the user's global install of PI Lead never turns a worker into a Lead.
- **Sub-agents through Herdr.** The Lead's guidance and the worker rules carry one recipe: split a pane beside the caller without focus (`herdr pane split --current … --no-focus`), run a non-interactive Pi there with the PI Lead marker set, writing its answer to a report file, wait for its completion marker (`herdr pane wait-output`), read the report, close the pane. Skills that ask for sub-agents use it as written; if Herdr is unavailable, run the sub-agent steps one after the other in the same context and say so in the output.
- **`git_read` removed.** The Lead uses git and gh through bash.
- **Waiting timeout.** `waitingTimeoutMinutes` defaults to 0 (off); the setting stays for users who want it.
- **Default tier.** With no Jev difficulty, debug and review start at `standard`, as documented.
- **Dead code.** Remove the legacy Herdr metadata fallback and tab-rename switch-off (Herdr 0.9.1 is required), the stale "workers never receive the Herdr socket" comments, the context snapshot's symlink rejection and size budgets, and the host check's anti-evasion parts (symlinked parents, case folding, `package.json` scripts diff); the host check keeps its short pattern list as a review hint.
- **ADR 0007** records: the Lead implements single-session work; one worker per ticket running `/implement` as written (no scout, no scope fence, no readiness gate); workers are plain Pi; sub-agents run in Herdr panes.

## Testing Decisions

- Test external behaviour at the highest existing seams: the `lead` extension registration (tools, flags, inertness), `createDelegator` with its fake Herdr and fake judge, the worker extension's `finish`, `leadGuidance` text, and `loadConfigWithNotices`. No new seams.
- Prior art: `test/delegate.test.ts` (fake Herdr, fake judge, outcomes and report text), `test/lead.test.ts` (registered tools and commands), `test/worker.test.ts` (worker extension handlers), `test/config.test.ts`.
- Removed mechanisms lose their tests; each removal gets one assertion that the old behaviour is gone where a user could observe it (no `scout` phase, no `not_ready`, no `git_read` tool, Lead inert under the marker).
- New behaviour gets tests: one send-back of a CI/verify partial then a user-facing report; PR head mismatch counts as pending; verdict check skipped on proven work; worker command has no `--no-extensions`; guidance contains the Herdr sub-agent recipe and the routing rule.
- `npm test` and `npm run typecheck` stay green after every ticket.

## Out of Scope

- Removing `web_search`: revisit once workers load the user's extensions and it is clear whether it is still needed.
- Simplifying the Jev budget ledger, hard-coding rarely used Jev settings, and changing overlap scheduling.
- Removing `verify` or the host check entirely.
- Commenting on mattpocock/skills#561 (only if the user asks).
- Any change to Matt's vendored skills: PI Lead adapts through its own guidance, not by editing them.
