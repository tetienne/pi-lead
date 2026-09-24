---
status: accepted
---

# Verify code work with a command the project chooses, not one the worker ran

Decided 2026-09-24.

A worker's own test runs were evidence the model picked: a heuristic guessed
which shell command was a test run (`lastTest`), and an unverified `done` was
sent back once (`steerUnverifiedDone`). Both are removed. Instead a trusted
project names one `verify` command in its `.pi/pi-lead.json`; when implement,
prototype or debug work finishes `done` or `partial`, the worker extension
(host-side code) commits what is left and runs it in the worker's VM at
`/workspace`, bounded by `verifyTimeoutMinutes` and stoppable by the user.

- **Who chooses the command.** Only the project file of a trusted project, read
  from the user's checkout; the global config cannot set it, and the Lead
  counts a result's run only when its command equals its own config. The
  command reaches the worker in its host-side task file, out of the guest's
  reach.
- **What it proves.** The guest controls the repository, so it can change what
  `verify` runs (a script, a test). `verify` catches honest mistakes; the
  sensitive-path review hint names changed `package.json` scripts, `.pi` and
  similar. The
  output is guest text: it stays in the untrusted report block, while the
  command and exit code are host text.
- **Policy, not judgment** ([ADR 0003](0003-bound-jev-judgments-with-policy.md)):
  a failed or unfinished run makes `done` at most `partial`, whatever the
  worker or Jev says; Jev still sees the run as evidence. Without `verify`, the
  report says the work is unverified and nothing else changes.
