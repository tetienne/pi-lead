---
status: superseded by ADR-0007
---

# Verify code work with a command the project chooses, not one the worker ran

PI Lead used to run one `verify` command, named in a trusted project's
`.pi/pi-lead.json`, in the worker's worktree after it finished, and capped a
failed run to `partial`. The worker controlled the worktree and so what
`verify` ran; it caught honest mistakes only, and duplicated what the
project's own git hooks and CI already check. It is removed: verification is
the project's hooks on the worker's commits and CI on its draft PR (ADR 0007).
