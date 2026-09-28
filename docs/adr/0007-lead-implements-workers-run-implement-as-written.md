---
status: accepted
---

# The Lead implements single-session work; one worker per ticket runs `/implement` as written

PI Lead was designed while workers ran in a sandbox, so work took a long,
fenced path: the Lead never changed code, Jev refused tickets it judged not
ready, a scout worker fixed the files an implementer worker could touch, and
PI Lead ran its own `verify` command and capped what Jev cost. With workers on
the host (ADR 0005) that path protected nothing a worker could not already do
(ADR 0006), made a one-line fix cost two workers and a CI watch, and departed
from Matt Pocock's flow, which PI Lead claims to follow. We follow Matt's flow
as written instead:

- **The Lead implements single-session work.** After grilling, the Lead asks
  one question (spec, tickets, or implement now) and takes `ask-matt`'s
  multi-session branch: single-session work runs `/implement` in the Lead's
  own session; a multi-session build goes through `/to-spec` and
  `/to-tickets`, then one `delegate` per ticket. The user can always ask to
  delegate.
- **One worker per ticket runs `/implement` as written:** test-first in
  vertical slices through `/tdd`, then `/code-review`. No scout, no scope
  fence, no readiness gate: an approved ticket always starts, and a worker
  that finds a real gap reports `needs_human` in its own words. An up-front
  list of files and tests contradicts `/tdd`, where each cycle teaches what
  the next test is.
- **Jev only routes tiers and checks verdicts.** No readiness, severity,
  failure-kind or overlap judgment, and no spend budget (ADR 0002). Jev's
  overlap guess saw only ticket text and a queued worker still started from
  the same base, so it delayed conflicts rather than preventing them.
- **Sequencing is the tickets' Blocked-by edges plus a one-at-a-time merge.**
  A blocked ticket is delegated once its blockers' PRs have merged (or started
  from a blocker's branch when the user asks for stacking); every other ticket
  runs in parallel. On the user's go-ahead, green PRs merge one at a time,
  each updated from its base and green again on its new head, because
  parallel branches merged at once break each other (mattpocock/skills#493).
  Parallelism is bounded by the human's review capacity, not by a cap in code.
- **Verification is the project's own:** its git hooks (prek, for example) on
  the worker's commits and CI on the worker's draft PR, which the host checks
  on the branch head. A failed or pending CI goes back to the worker once
  before it reaches the user. PI Lead no longer runs a command of its own
  (supersedes ADR 0004).
- **Workers are plain Pi** with the user's extensions and inherit the Lead's
  project trust (ADR 0003), so a worker can use what the user's Lead can.
- **Sub-agents run in Herdr panes.** Pi has no sub-agents, and Matt's skills
  that ask for them (code-review's two axes, grilling, wayfinder,
  improve-codebase-architecture, codebase-design) silently collapse into one
  context (mattpocock/skills#561). The Lead and workers start each sub-agent
  as a non-interactive Pi in a Herdr pane beside them and read its report;
  without Herdr they run the steps one after the other and say so.
- **A restarted Lead adopts live workers** of its repository (ADR 0001), so a
  crash does not cost the work in flight.

## Consequences

- These choices assume a developer at their own machine with a human in the
  loop: the human approves specs and tickets, answers `needs_human`, reviews
  PRs and says when to merge. Running PI Lead headless or in CI, with no one
  watching, would need a sandbox and scoped credentials again
  (https://claude.com/blog/the-ai-native-sdlc-playbook), and with them a
  review of ADR 0005 and ADR 0006.
