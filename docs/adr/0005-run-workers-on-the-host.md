---
status: accepted
---

# Run workers on the host, in their own git worktree

A worker's Pi runs on the host, its working directory a git worktree of the
repository in its own Herdr workspace. Its commits land on its branch in the
repository itself; removing the worktree keeps the branch. There is no VM,
container image, sidecar service, toolchain cache or egress allowlist: the
isolation machinery cost more to keep working than it protected, and it drove
most of the codebase.

The trade-off is deliberate: a worker has the same network, filesystem and
credential access as the user running the Lead, and a linked worktree shares
the repository's `.git` (config, hooks, refs). Isolation between workers and
from the user's checkout comes only from separate worktrees and branches.
This holds for a developer at their own machine (ADR 0007 states the limit).
