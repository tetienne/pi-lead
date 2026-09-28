# 17: Workers inherit the Lead's project trust

**What to build:** A worker trusts its worktree exactly when the Lead trusts the project: it then loads the project's own extensions, skills, prompts and APPEND_SYSTEM.md from the worktree by Pi's normal discovery, and PI Lead no longer copies project resources out of the worktree. An untrusted project stays untrusted in its workers. The snapshot existed only because a fresh worktree path is untrusted in Pi; passing the Lead's decision per process (`--approve` / `--no-approve`, see Pi's docs/cli.md and docs/security.md) makes it unnecessary.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Read Pi's docs on project trust (`--approve`, `--no-approve`, trust-gated resources) first and rely on them.
- [ ] A worker of a trusted project starts with `--approve`; of an untrusted one with `--no-approve` (test).
- [ ] The context snapshot module, its copying and its `--skill`/`--prompt-template`/`--append-system-prompt` arguments are removed (test on the worker command).
- [ ] A worker of a trusted project loads project extensions (README says so); an untrusted one loads none.
- [ ] `npm test` and `npm run typecheck` pass.
