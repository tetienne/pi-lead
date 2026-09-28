---
status: accepted
---

# Workers get an independent review before they finish

Implement and debug workers get a `review` tool. It runs a fresh
`pi --print` on the `tiers.review` model, with no
extensions and no project config, on `/skill:code-review` against the
ticket's base and the committed diff. The worker judges each finding, fixes,
and calls `review` again with the previous findings.

- **A different model in a fresh context.** The worker's own model reviewing
  its own work in its own context shares its blind spots; a second model that
  sees only the ticket and the diff does not. The model differs only when
  `tiers.review` is configured: without it, the review takes the `standard`
  tier's route, possibly the worker's own model (still a fresh context), and
  the Lead is told so.
- **The finish gate.** `finish done` is refused unless the worktree is clean
  and a review covers the current HEAD, so a fix made after the last review
  is reviewed too.
- **Two fix rounds.** `review` runs at most three times: the first review and
  two re-reviews. A failed or empty reviewer run counts toward the three; an
  empty diff does not run the reviewer and costs nothing. Findings that remain
  after that make the worker finish `blocked` and list them, instead of looping.
  The count survives a reload of the worker's session.

## What this replaces

- **Jev** (ADR 0002): its verdict could cap a worker's `done`, which cancelled
  the automatic fix of review findings. The Lead now picks the tier itself
  (`delegate` `tier`, default `standard`).
- **The scout worker**: it re-read the ticket and the code the implementer
  reads again anyway.
- **`verify`** (ADR 0004): it re-ran checks that CI already runs on the
  worker's draft PR, which the worker gets green before it finishes.
- Stuck detection, overlap scheduling, the Lead guard and `git_read` went
  with them: machinery the workflow no longer needs.
