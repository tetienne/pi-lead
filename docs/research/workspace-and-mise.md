# Workspace and mise boundary

Source inspection on 2026-09-21; recommendations below are not implemented or approved architecture.

Git worktrees share repository data, refs, and normally config. A worktree directory is therefore not a security boundary; mounting the shared metadata writable into a worker also exposes state outside that worker's task. [Git worktree documentation](https://git-scm.com/docs/git-worktree)

Installed mise 2026.9.1 `mise trust --help` states that configuration can execute code or affect the environment, normal-mode execution commands automatically trust active configuration, and trust can be shared across Git worktrees. Paranoid mode requires content-bound trust. Current upstream also documents automatic trust for configured directory prefixes. [mise trust](https://mise.jdx.dev/cli/trust.html), [settings](https://mise.jdx.dev/configuration/settings.html#trusted_config_paths)

## Candidate design

- The trusted host owns consuming-project branches and any host worktrees. Guest Git metadata is private; evaluate native Git clone/archive/bundle primitives before implementing a workspace format.
- Only explicitly selected project inputs enter the guest. A committed file can contain secrets too; copying tracked files alone is not a secret filter.
- Run project-defined mise tasks, dependency installation, Git hooks, and validation inside the isolated environment. Host integration must not execute guest-provided hooks, filters, configuration, or result strings.
- Use mise natively for pinned guest toolchains. Shared caches are read-only seeds with worker-private writable storage; do not mount the host's mise home or credentials. Verify Linux ABI and architecture compatibility before promising toolchain support.
- Preserve the consuming project's uncommitted work. Candidate initial behavior uses a committed base and asks only when the requested task needs local changes included.

## Evidence still needed

Choose and validate the native Git transfer mechanism, path/symlink confinement, binary/rename/mode preservation, and clean host integration. Measure image preparation separately from warm worker startup. Mise availability does not establish that host binaries are usable inside the Linux guest.
