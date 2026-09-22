# PI Lead

A reusable Pi package for engineering work with visible Herdr workers, whole-worker isolation, deterministic policy and the Matt Pocock workflow.

## Project status

The original specification and 16-ticket implementation program have been
audited against the bootstrap brief. Their isolation, policy and lifecycle
evidence is retained, but the product surface drifted into provider-, skill- and
stage-specific commands before the conversation-first Lead path was complete.
The approved cleanup is Tickets 17–20: refocus the contract, connect one
orchestrator, contract the public surface, then validate the refocused product.

Tickets 17 and 18 define and implement the unified product interface. Ticket 19
has removed the historical provider-, skill- and lifecycle-stage commands from
discovery and from the release archive; Ticket 20 owns the final
current-release proof.

## Approved product interface

Stay in one persistent Lead conversation and ask normally: “implement X”,
“debug Y”, “review this branch”, “research Z” or “help me shape this idea”. The
Lead owns intent routing, Matt workflow selection, provider/model selection,
isolated worker lifecycle, validation, review and cleanup. Ordinary chat starts
no worker.

`/lead <request>` is the sole explicit PI Lead escape hatch. It submits the same
natural-language request to the same orchestrator when automatic routing needs
help; it does not select a provider, skill or lifecycle stage. No other PI Lead
command is part of the approved product surface.

The current release boundary is local activation on macOS arm64 with ChatGPT
Pro workers. It may produce validated, independently reviewed local task-branch
commits. Automatic push/publication, dependency-frontier scheduling, cache
optimization, Linux support and OpenCode Go are deferred. Recovery and
diagnostic retention remain required core behavior. The complete command and
module disposition is recorded in the
[standalone specification](.scratch/pi-lead/spec.md#authoritative-product-contract--2026-09-22).

## Start here

- [Bootstrap brief](PI_LEAD_BOOTSTRAP.md)
- [Approved specification](.scratch/pi-lead/spec.md)
- [Ticket graph and index](.scratch/pi-lead/ticket-proposal.md)
- [Current cleanup frontier](.scratch/pi-lead/issues/19-contract-public-surface.md)
- [First ticket: isolated fixture](.scratch/pi-lead/issues/01-isolated-fixture.md)
- [Second ticket: ChatGPT worker](.scratch/pi-lead/issues/02-chatgpt-worker.md)
- [Third ticket: validated proposed change](.scratch/pi-lead/issues/03-validated-proposed-change.md)
- [Domain glossary](CONTEXT.md)
- [Decisions and research index](docs/planning/decisions.md)
- [Local tracker conventions](docs/agents/issue-tracker.md)

The current release scope is macOS arm64 with ChatGPT Pro. Ubuntu 24.04 LTS x86_64/arm64 and OpenCode Go remain deferred work, not compatibility claims. Jev uses OpenRouter with a $1/day ceiling, not a spending target; mise manages project toolchains.

See [historical release evidence](docs/release-acceptance.md) for the measured
macOS proofs and their limits. That evidence predates the refocused interface;
Ticket 20, not the superseded Ticket 16 narrative, will establish current
product acceptance.

## Development and historical evidence

The remaining sections document repository-only harnesses and capabilities
built by the original ticket program. They are useful to reproduce
implementation evidence, but they are not installed commands, product
workflows or contents of the release archive.

### Stage a local release archive

The checkout command below is useful while developing PI Lead, but a filesystem
path is not a native Pi package pin. To stage the release artifact locally:

```bash
npm pack
pi install -l --approve /absolute/path/to/pi-lead-0.1.0.tgz
```

`--approve` grants trust for that install command only; the package setting is
written to the consuming project's `.pi/settings.json`. A true reproducible Pi
pin must be an explicitly versioned npm source or a git commit source. Creating
or publishing either destination remains a human gate and is not part of this
package.

### Run the isolated fixture proof

The pinned baseline is Node 24.14.1, Pi 0.86.1, Herdr 0.8.0 and Gondolin 0.12.0. QEMU must be available on the host.

From a consuming project, activate this checkout as a project-local Pi package:

```bash
pi install -l /absolute/path/to/pi-lead
```

The `npm run fixture` harness creates a named tab with `--no-focus`; a trusted
host launcher runs the harmless task in a Gondolin VM
with an empty network allowlist, no host mounts and a newly constructed guest
environment. A successful result is bound to its task, assignment, worker, VM,
tab and pane IDs. The Lead collects it, confirms that the VM process has
terminated, and only then closes the successful tab. Failed runs retain their
stopped diagnostic tab and host-owned artifacts. Run it from this repository
checkout to reproduce the proof.

For repository checks:

```bash
npm test
npm run typecheck
npm run fixture
```

`npm run fixture` is the direct integration harness and must itself run inside Herdr. It does not use a model or provider account.

### Run the ChatGPT worker proofs

These direct repository harnesses exercise the ChatGPT adapter without adding
provider-specific request vocabulary to the installed Lead. Ordinary chat,
steering, follow-ups and extension-originated messages cannot create workers;
engineering requests admitted by the unified orchestrator share one
two-worker concurrency limit.

The worker runs the pinned native Pi JSON lifecycle in a Gondolin PTY inside the named Herdr tab and streams its native events there without taking Lead focus. The guest sees only synthetic provider placeholders. A trusted host hook refreshes and injects the ChatGPT OAuth bearer and account identity for the exact HTTPS `POST https://chatgpt.com/backend-api/codex/responses` request, rejects redirects, compressed responses and credential-bearing response headers or bodies, and never mounts the host filesystem. The streaming body guard detects credentials split across chunks before those bytes reach the guest. Cache warming and provider fallback are disabled. Success requires correlated native `agent_start`, authoritative assistant `message_end` and `agent_end` events; an idle or settled screen is not completion.

Run the credential-free proofs inside Herdr:

```bash
npm run chatgpt-fixture
npm run chatgpt-cancel-fixture
npm run chatgpt-reflection-fixture
```

The first proves a complete native Pi SSE turn against an in-memory fake upstream, including host-only credential injection and guest-storage scanning. The second proves cancellation before the provider call and zero upstream requests. The third makes the allowed upstream reflect the injected bearer across response chunks and proves that the host blocks it before it reaches Pi, guest storage remains clean and host artifacts remain redacted.

`npm run chatgpt-live` performs the minimal real subscription-backed proof. Do not run it until the operator has checked the current Codex usage dashboard and confirmed that no purchased or workspace credits can be consumed. OAuth readiness proves authentication only; it does not prove that usage cannot spill from included plan limits into credits. Quota exhaustion, refresh failure and model unavailability stop the worker with no API-key or paid-provider fallback.

The unified orchestrator applies the same gate: set
`PI_LEAD_CHATGPT_INCLUDED_QUOTA_CONFIRMED=yes` only for a session in which the
operator has made that current confirmation. Without it, worker admission stops
before dispatch.

Current runtime evidence covers macOS arm64 only. Ubuntu 24.04 and Linux arm64/x86_64 remain unrun. A missing/incompatible native Herdr pane identity is a feasibility blocker; the implementation does not fall back to host execution or weaken isolation.

### Reproduce a validated proposed change

The repository fixture supplies a named branch, mise task names and the exact
dependency destinations the guest may contact directly to the internal adapter.

The Lead transfers only the named committed base through a Git bundle into a private Gondolin workspace. The worker has no host mount or control socket. Git 2.52.0 and mise 2025.8.20 are installed from the explicitly allowed Alpine repository when absent; project tool downloads need their own `--allow` entries. A rejected destination blocks the task and never expands the allowlist automatically.

After the edit, the guest creates a synthetic proposal commit whose only parent is the selected base, resets to that exact commit for each declared `mise run <task>` check, and rejects a check that changes tracked content. The host imports the returned bundle into a fresh bare repository with system/global Git configuration, hooks, filters, external diffs and submodule recursion disabled. It collects bounded changed, added, deleted and renamed files, raw bytes, modes and confined symlink targets without checking out or executing guest content.

A successful adapter run returns `REVIEW_REQUIRED`; it neither creates a host
commit nor publishes anything. Review, correction and host commit are exercised
through the unified Lead implementation lifecycle.

Run the credential-free macOS arm64 proofs inside Herdr:

```bash
npm run change-fixture
npm run change-denied-fixture
npm run change-mutating-check-fixture
```

The positive fixture executes its controlled edit process inside the VM and proves transfer, isolated mise validation, exact artifact collection, checkout preservation and confirmed cleanup. The negative fixtures prove a precise dependency denial with no policy expansion and rejection of a validation task that mutates the proposed tree. The real Pi/provider path reuses Ticket 02's host-mediated ChatGPT worker, but was not charged again for this ticket; Ubuntu 24.04 coverage remains assigned to Ticket 08.

### Historical safe mise cache experiment

Toolchain cache seeds are host-owned and keyed by the committed `.mise.toml`, the pinned guest mise package, Linux guest architecture and musl ABI. A seed becomes reusable only after a trusted host provisioning flow has populated it and called `attestToolchainSeed`; its manifest includes a content digest. Guest workers receive that seed read-only at `/opt/pi-lead/mise-seed`, copy it into worker-private mise directories, and never promote writable worker content back into a seed. The cold/warm fixture can persist a comparison artifact and records `NO_IMPROVEMENT` when its measured preparation, readiness and validation phases do not all improve. This runtime evidence is macOS arm64 only; it does not establish Ubuntu coverage.

Cache optimization is deferred from the current release because the measured
warm path did not improve. Private writable worker storage and the prohibition
on shared writable global caches remain security requirements.

### Historical controlled publication capability

The original program built and tested a policy that can publish only an exact
`pi-lead/task-<task-id>` branch. Automatic publication is deferred from the
current release and this configuration is retained only as historical
implementation evidence:

```bash
export PI_LEAD_GIT_REMOTE=origin
export PI_LEAD_GIT_REMOTE_URL=https://git.example.invalid/your-org/your-project.git
```

The name and exact URL form one trusted remote configuration; PI Lead does not read a repository-defined remote for publication. It never creates a remote, chooses among remotes, uses a force refspec, overwrites an existing different remote task branch, or publishes a protected/arbitrary branch. Before each attempt it records the exact intended remote/ref/commit in its host-owned run state; it records the observed result after reconciliation. A failed or unreconciled push leaves the reviewed local branch intact and reports `BLOCKED`; retrying starts by observing the remote branch again. PR creation, merges, deployment and privileged operations have no automatic publication path and remain human gates.

### Planning assets

The local tracker under `.scratch/` is intentionally versioned. The installed Matt skills under `.agents/skills/` and `skills-lock.json` preserve the workflow inputs used for this plan; this does not grant third-party code host privileges.

No GitHub repository, remote, external issue tracker or account setup is needed to review the plan. Request credentials or human-only setup only when a concrete implementation check needs them; never put secrets in the tracker or chat.
