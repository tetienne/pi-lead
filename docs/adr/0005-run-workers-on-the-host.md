---
status: accepted
---

# Run workers on the host, in their own git worktree

A worker's Pi runs on the host with its stock tools, its cwd a git worktree of
the repository created by `herdr worktree create`, which also gives it its own
Herdr workspace. Its commits land on its branch in the repository itself;
removing the worktree (`herdr worktree remove`) keeps the branch. There is no
VM, container image, sidecar service, toolchain cache or egress allowlist: the
isolation machinery cost more to keep working than it protected, and it drove
most of the codebase.

The trade-off is deliberate: a worker has the same network and filesystem
access as the user running the Lead, and a linked worktree shares the
repository's `.git` (config, hooks, refs). Isolation between workers and from
the user's checkout comes only from separate worktrees and branches.
