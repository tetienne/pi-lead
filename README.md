# PI Lead

A reusable Pi package for engineering work with visible Herdr workers, whole-worker isolation, deterministic policy and the Matt Pocock workflow.

## Project status

The specification, architectural decisions and 16-ticket breakdown are approved. Ticket 01 supplies the native package, thin Lead entry point, isolated fixture lifecycle and the first macOS arm64 Gondolin/Herdr runtime proof. Later tickets add real Pi workers, providers, Git delivery and recovery.

## Start here

- [Bootstrap brief](PI_LEAD_BOOTSTRAP.md)
- [Approved specification](.scratch/pi-lead/spec.md)
- [Ticket graph and index](.scratch/pi-lead/ticket-proposal.md)
- [First ticket: isolated fixture](.scratch/pi-lead/issues/01-isolated-fixture.md)
- [Domain glossary](CONTEXT.md)
- [Decisions and research index](docs/planning/decisions.md)
- [Local tracker conventions](docs/agents/issue-tracker.md)

ChatGPT Pro is the first worker provider; OpenCode Go remains supported when included quota is available. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Target hosts are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64, with mise-managed toolchains.

## Install and run the isolated fixture

The pinned baseline is Node 24.14.1, Pi 0.86.1, Herdr 0.8.0 and Gondolin 0.12.0. QEMU must be available on the host.

From a consuming project, activate this checkout as a project-local Pi package:

```bash
pi install -l /absolute/path/to/pi-lead
```

Start Pi inside Herdr and run `/lead-fixture`. The Lead creates a named tab with `--no-focus`; a trusted host launcher runs the harmless task in a Gondolin VM with an empty network allowlist, no host mounts and a newly constructed guest environment. A successful result is bound to its task, assignment, worker, VM, tab and pane IDs. The Lead collects it, confirms that the VM process has terminated, and only then closes the successful tab. Failed runs retain their stopped diagnostic tab and host-owned artifacts.

For repository checks:

```bash
npm test
npm run typecheck
npm run fixture
```

`npm run fixture` is the direct integration harness and must itself run inside Herdr. It does not use a model or provider account.

Current runtime evidence covers macOS arm64 only. Ubuntu 24.04 and Linux arm64/x86_64 remain unrun, as do a real guest Pi worker and ChatGPT authentication. A missing/incompatible native Herdr pane identity is a feasibility blocker; the implementation does not fall back to host execution or weaken isolation.

## Planning assets

The local tracker under `.scratch/` is intentionally versioned. The installed Matt skills under `.agents/skills/` and `skills-lock.json` preserve the workflow inputs used for this plan; this does not grant third-party code host privileges.

No GitHub repository, remote, external issue tracker or account setup is needed to review the plan. Request credentials or human-only setup only when a concrete implementation check needs them; never put secrets in the tracker or chat.
