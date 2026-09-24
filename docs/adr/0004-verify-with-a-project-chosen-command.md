---
status: accepted
---

# Verify code work with a command the project chooses, not one the worker ran

A trusted project names one `verify` command in its `.pi/pi-lead.json`. When
implement, prototype or debug work finishes `done` or `partial`, the worker
extension commits what is left and runs it in the worker's worktree, bounded by
`verifyTimeoutMinutes` and stoppable by the user.

- **Who chooses the command.** Only the project file of a trusted project, read
  from the user's checkout; the global config cannot set it, and the Lead
  counts a result's run only when its command equals its own config.
- **What it proves.** The worker controls the worktree, so it can change what
  `verify` runs (a script, a test). `verify` catches honest mistakes; the
  sensitive-path review hint names changed `package.json` scripts, `.pi` and
  similar.
- **Policy, not judgment** (ADR 0002): a failed or unfinished run makes `done`
  at most `partial`, whatever the worker or Jev says; Jev still sees the run as
  evidence. Without `verify`, the report says the work is unverified.
