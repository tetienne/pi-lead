# PI Lead

A planned reusable Pi package for engineering work in natural language, with visible Herdr workers, whole-worker isolation, deterministic policy and the Matt Pocock workflow.

## Project status

The specification, architectural decisions and 16-ticket breakdown are approved. Planning tickets are published locally, and the local Git repository is initialized on main with no remote. Application implementation has not started; the original request to pause implementation still applies until the user asks to begin.

## Start here

- [Bootstrap brief](PI_LEAD_BOOTSTRAP.md)
- [Approved specification](.scratch/pi-lead/spec.md)
- [Ticket graph and index](.scratch/pi-lead/ticket-proposal.md)
- [First ticket: isolated fixture](.scratch/pi-lead/issues/01-isolated-fixture.md)
- [Domain glossary](CONTEXT.md)
- [Decisions and research index](docs/planning/decisions.md)
- [Local tracker conventions](docs/agents/issue-tracker.md)

ChatGPT Pro is the first worker provider; OpenCode Go remains supported when included quota is available. Jev uses OpenRouter with a $1/day ceiling, not a spending target. Target hosts are macOS arm64 and Ubuntu 24.04 LTS x86_64/arm64, with mise-managed toolchains.

Research establishes source-level candidate integrations. No VM, provider, security or application acceptance tests have run yet. There are no application build/test commands or installation artifact to use at this stage.

## Planning assets

The local tracker under `.scratch/` is intentionally versioned. The installed Matt skills under `.agents/skills/` and `skills-lock.json` preserve the workflow inputs used for this plan; this does not grant third-party code host privileges.

No GitHub repository, remote, external issue tracker or account setup is needed to review the plan. Request credentials or human-only setup only when a concrete implementation check needs them; never put secrets in the tracker or chat.
