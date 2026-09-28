# Ecosystem research: Pi, Matt Pocock's skills, opencode (as of 2026-09-28)

Legend: **[V]** verified by reading the primary source in this session; **[S]** seen only in a search-result snippet or secondary write-up (blog domain was blocked by the egress proxy, so not fetched); **[I]** my inference.

## TL;DR

- Pi's core refuses sub-agents, plan mode, permission popups, built-in to-dos and background bash; the documented alternative is "spawn pi instances via tmux", plans in files, a `TODO.md`, containers [V] (Pi README Philosophy, npm `@mariozechner/pi-coding-agent` 0.73.1). Requests for native sub-agents are closed "not planned" [V] (earendil-works/pi#7412, #7808).
- Mario Zechner's position: parallel sub-agents building features is an anti-pattern; human review capacity is the real limit; cap agent output per day to what you can review and hand-write architecture/APIs [S] (his 2026-03-25 "slowing the f down" post, 2025-11-30 pi post).
- Matt Pocock's own flow is *conditional*: small changes go straight to `/implement`; `/to-spec`+`/to-tickets` only for multi-session work [V] (ask-matt SKILL.md). `/implement` = one ticket, fresh context, commits to current branch, no PR, no ticket closing, and running several side by side in one checkout is "worse than unsupported" [V] (docs/engineering/implement.md).
- Matt does parallelism *outside* the skills, in Sandcastle: planner picks unblocked issues, each implementer on its own branch/sandbox, then review and a merger [V] (mattpocock/sandcastle). He says ~80% AFK / 20% HITL, mostly reviewing outputs [S] (X, 2026).
- Biggest community complaint about the skills is not ceremony but *unwanted stage-skipping*: grilling "Agreed" is taken as licence to implement [V] (skills#975, #570, #1068). Other asks: a requirement-questioning gate to *cut* scope (#947), and worktree-per-ticket for parallel `/implement` (#493).
- opencode: Build/Plan primary agents, `general`/`explore`/`scout` subagents via the Task tool, permissions `ask/allow/deny` incl. `permission.task` [V] (opencode agents.mdx). Subagents share the parent's directory; worktree isolation exists only in plugins/forks and open requests [V] (opencode#49824, #49842).
- Community Pi orchestration converges on: scout → (planner) → worker → reviewer, background runs with a fleet view, child escalates instead of guessing [V] (Pi `examples/extensions/subagent`, nicobailon/pi-subagents).

## Pi ecosystem

- Core philosophy [V] ([npm README](https://registry.npmjs.org/@mariozechner/pi-coding-agent)): "No sub-agents. … Spawn pi instances via tmux, or build your own with extensions, or install a package"; "No permission popups. Run in a container, or build your own confirmation flow"; "No plan mode. Write plans to files"; "No built-in to-dos. They confuse models. Use a TODO.md"; "No background bash. Use tmux. Full observability, direct interaction." The current package (`@earendil-works/pi-coding-agent` 0.87.1, local `node_modules`) keeps this: `docs/security.md` says Pi "does not ask for approval before every tool call" [V].
- Mario on permission prompts: calls them security theater — if the agent can read data, run code and reach the network, it's game over; accept YOLO or use a container [S] ([pi post, 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)).
- Mario on multi-agent: "spawning multiple sub-agents to implement various features in parallel is an anti-pattern… unless you don't care if your codebase devolves into a pile of garbage" [S] (same post); for parallel work, use a separate session and bring back a concrete artifact [S] ([tldrecap AIE Europe 2026](https://tldrecap.tech/posts/2026/aie-europe/pi-agent-minimalism/)). "Slow down" post (2026-03-25): agents compound "booboos" with no bottleneck; limit daily generated code to what you can review; write architecture, APIs and core abstractions by hand [S] ([post](https://mariozechner.at/posts/2026-03-25-thoughts-on-slowing-the-fuck-down/), [Charles Harries summary](https://charlesharri.es/stream/thoughts-on-slowing-the-fuck-down-mario-zechner)). Tweets "and now you know why pi doesn't have subagents built-in" and "Here's one way to do subagents in pi" exist [S] ([x.com/badlogicgames/status/2020466594497908792](https://x.com/badlogicgames/status/2020466594497908792), [2001088673698189732](https://x.com/badlogicgames/status/2001088673698189732)).
- Official example `examples/extensions/subagent` [V]: each subagent is a separate `pi` process; agents `scout` (compressed recon), `planner`, `reviewer`, `worker`; presets `implement` (scout → planner → worker), `scout-and-plan`, `implement-and-review` (worker → reviewer → worker).
- nicobailon/pi-subagents (~3.8k stars) [V] ([repo](https://github.com/nicobailon/pi-subagents)): built-ins scout, researcher, evidence-auditor, worker, reviewer, oracle, delegate; foreground or background (detached runner), FleetView to inspect/steer/stop; children "escalate unapproved decisions instead of guessing"; "Complexity alone does not authorize delegation"; parallel reviewers (correctness / tests / unnecessary complexity). Armin Ronacher notes the ecosystem grew via Nico's sub-agents, pi-interactive-shell etc., and that Pi users have the agent build its own skills (e.g. commit, reading shared sessions for review) [S] ([lucumr, 2026-01-31](https://lucumr.pocoo.org/2026/1/31/pi/)).
- Real-world friction: two concurrent `pi -c` runs in one directory append to one session file [V] ([pi#9596](https://github.com/earendil-works/pi/issues/9596), 2026-09-14).
- Package indexes: [pi.dev/packages](https://pi.dev/packages), [awesome-pi (BubblePtr)](https://github.com/BubblePtr/awesome-pi) [S]; qualisero/awesome-pi-agent now shows only a retirement notice [V].

## Matt Pocock's skills in practice

- Routing [V] ([ask-matt](https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md)): grill → (optional prototype) → multi-session? yes: to-spec → to-tickets → implement per ticket → code-review; no: `/implement` directly in the same window. Small changes skip to-spec; tight `/tdd` work skips the spec. Keep steps 1–3 in one window; each `/implement` starts fresh from its ticket.
- `/implement` [V] ([doc](https://github.com/mattpocock/skills/blob/main/docs/engineering/implement.md), [SKILL](https://github.com/mattpocock/skills/blob/main/skills/engineering/implement/SKILL.md)): `disable-model-invocation: true`; "clear context, implement one ticket, commit, clear again"; commits to the current branch, no PR, never touches the work item; the pre-commit `/code-review` diffs `<fixed-point>...HEAD` so may see nothing.
- `/to-tickets` [V] ([SKILL](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md)): vertical tracer-bullet slices sized to one fresh context window, blocking edges, quiz the user on granularity, work "the frontier: any ticket whose blockers are all done". Local files at `.scratch/<slug>/issues/NN-slug.md`.
- Triage labels `ready-for-agent` / `ready-for-human`; triage "recommends and waits" [S] ([triage-labels.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/triage-labels.md)).
- Parallelism: Sandcastle (supports Claude Code, Pi, Codex, Cursor, OpenCode, Copilot) with a parallel-planner template — plan parallelizable issues, one branch per agent, optional per-branch review, then merge; Claude Code AFK default is `--dangerously-skip-permissions` [V] ([sandcastle](https://github.com/mattpocock/sandcastle)). Workshop version: Sonnet implements, Opus reviews, in Docker worktrees [S] ([talksintel AIE EU 2026](https://talksintel.ai/ai-ml/conferences/aie-eu-2026/full-walkthrough-workflow-for-ai-coding-matt-pocock/)). "Parallelism is limited by review capacity… run as many pipelines as your review capacity can absorb" [S] (same/[alexop.dev](https://alexop.dev/posts/how-to-do-afk-coding/)). ~80% AFK / 20% HITL, "I mostly now review outputs" [S] ([X](https://x.com/mattpocockuk/status/2029484601698107629)).
- Complaints [V]: grilling confirmation jumps straight to implementation ([#975](https://github.com/mattpocock/skills/issues/975) 2026-08-26, [#570](https://github.com/mattpocock/skills/issues/570), [#1068](https://github.com/mattpocock/skills/issues/1068) with gpt-6-Astra-low); question batches arrive while the user is answering ([#948](https://github.com/mattpocock/skills/issues/948)); skills push small projects toward production-grade complexity — asks for a "question every requirement" gate ([#947](https://github.com/mattpocock/skills/issues/947)); parallel `/implement` in one tree caused an amend clobbering a sibling commit, stash races, and red/green attribution pain — proposed one ticket = one worktree + branch, serial merge, "only parallelize disjoint domains; when in doubt, serialize", and a file-overlap check in to-tickets ([#493](https://github.com/mattpocock/skills/issues/493), 2026-07-09).

## opencode

- Agents [V] ([agents.mdx](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx)): primary Build (all tools) and Plan (edits/bash = `ask`), Tab to switch; subagents `general`, `explore` (read-only), `scout` (external docs, read-only), invoked by the Task tool or `@mention`; child sessions navigable (Up = parent, Left/Right cycle); `mode`, `steps`, `hidden`, and `permission.task` globs restrict which subagents an agent may call.
- Isolation gap [V]: "The subagent tool creates every child session in the parent's location" ([#49824](https://github.com/anomalyco/opencode/issues/49824), 2026-09-18); a fork proposes durable background completion notices, monitors, and "subagents run in detached linked worktrees, removed when clean" ([#49842](https://github.com/anomalyco/opencode/issues/49842)). Plugins fill it: [opencode-worktree](https://github.com/kdcokenny/opencode-worktree) (auto-spawns a terminal per worktree, cleans up on exit), [opencode-worktree-session](https://github.com/felixAnhalt/opencode-worktree-session) [S].
- oh-my-opencode "Sisyphus": orchestrator firing parallel background subagents aggressively, 7–11 specialist agents (Oracle, Librarian, Explore) [S] ([DeepWiki](https://deepwiki.com/code-yeongyu/oh-my-opencode/4.2-sisyphus:-primary-orchestrator)).
- Matt skills on opencode: a fork [mattpocock-skills-opencode](https://github.com/fullheart/mattpocock-skills-opencode) and a community "Rig" wiki page [V/S]; no evidence found of a distinctive opencode-specific chaining pattern [I].

## Patterns worth adopting for PI Lead

1. **Route by size, not by default.** Let the Lead go straight to delegate-implement for small changes, reserving to-spec/to-tickets for multi-session work — this *is* ask-matt's rule ([ask-matt](https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md)).
2. **Explicit stage gate after grilling.** "Agreed" confirms a decision, it does not authorize the next stage; end grilling with a one-line "spec, tickets, or implement now?" ([#975](https://github.com/mattpocock/skills/issues/975), [#1068](https://github.com/mattpocock/skills/issues/1068)).
3. **Keep one ticket = one worktree + branch; add file-overlap to parallelism decisions**, serialize when unsure ([#493](https://github.com/mattpocock/skills/issues/493)) — PI Lead's Herdr worktrees + Jev overlap check already match; this validates them.
4. **Cap concurrency to review capacity**, not to machine capacity (Matt [S], Mario [S] above). A small default max-live-workers is justified [I].
5. **Scout → worker → reviewer is the common shape**, but make the scout cheap/optional for small tickets (Pi subagent example `implement` preset; pi-subagents "complexity alone does not authorize delegation").
6. **Children escalate rather than guess** (pi-subagents) — matches PI Lead's `?` waiting state.
7. **No permission prompts; rely on isolation + review hints** (Pi philosophy, Mario) — consistent with ADR 0006.
8. **Question requirements to shrink scope before grilling expands it** ([#947](https://github.com/mattpocock/skills/issues/947)).

## Anti-patterns / things people dropped

- Parallel feature sub-agents in one tree / without review budget (Mario [S]; [#493](https://github.com/mattpocock/skills/issues/493) incidents [V]).
- Built-in to-do lists ("they confuse models") and plan mode as a special state — files instead ([Pi README](https://registry.npmjs.org/@mariozechner/pi-coding-agent)) [V].
- Permission popups as security (Mario [S]; Pi docs [V]).
- `/to-prd` and `/to-issues` renamed/replaced by `/to-spec` and `/to-tickets` (July 2026) [S] (search snippet on mattpocock-skills-opencode).
- Black-box sub-agents whose work you can't observe — Mario prefers tmux/sessions with full observability [V] (Pi README "No background bash").

## Sources

- https://registry.npmjs.org/@mariozechner/pi-coding-agent (README Philosophy)
- node_modules/@earendil-works/pi-coding-agent 0.87.1: docs/security.md, examples/extensions/subagent/README.md
- https://github.com/earendil-works/pi/issues/7412 · /7808 · /9596
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- https://mariozechner.at/posts/2026-03-25-thoughts-on-slowing-the-fuck-down/
- https://charlesharri.es/stream/thoughts-on-slowing-the-fuck-down-mario-zechner
- https://tldrecap.tech/posts/2026/aie-europe/pi-agent-minimalism/
- https://x.com/badlogicgames/status/2020466594497908792 · https://x.com/badlogicgames/status/2001088673698189732
- https://lucumr.pocoo.org/2026/1/31/pi/
- https://github.com/nicobailon/pi-subagents
- https://pi.dev/packages · https://github.com/BubblePtr/awesome-pi
- https://github.com/mattpocock/skills (README, ask-matt, implement, to-tickets, triage-labels)
- https://github.com/mattpocock/skills/issues/493 · /570 · /947 · /948 · /975 · /1068
- https://github.com/mattpocock/sandcastle
- https://x.com/mattpocockuk/status/2029484601698107629
- https://talksintel.ai/ai-ml/conferences/aie-eu-2026/full-walkthrough-workflow-for-ai-coding-matt-pocock/
- https://alexop.dev/posts/how-to-do-afk-coding/
- https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx
- https://github.com/anomalyco/opencode/issues/49824 · /49842
- https://github.com/kdcokenny/opencode-worktree · https://github.com/felixAnhalt/opencode-worktree-session
- https://deepwiki.com/code-yeongyu/oh-my-opencode/4.2-sisyphus:-primary-orchestrator
- https://github.com/fullheart/mattpocock-skills-opencode
