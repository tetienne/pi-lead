# PI Lead

A reusable Pi package for engineering work with visible Herdr workers, whole-worker isolation, deterministic policy and the Matt Pocock workflow.

## Project status

The specification, architectural decisions and 16-ticket breakdown are approved. Ticket 01 supplies the native package, thin Lead entry point, isolated fixture lifecycle and the first macOS arm64 Gondolin/Herdr runtime proof. Ticket 02 adds the first real Pi worker path with host-mediated ChatGPT subscription authentication; its fake-provider, cancellation, hostile-reflection and live subscription proofs pass on macOS arm64. Ticket 03 adds a private Git workspace, isolated mise checks and a review-required proposed-change artifact without modifying or committing the host checkout. Ticket 05 adds controlled publication of a reviewed task branch to one explicitly configured consuming-project remote.

## Start here

- [Bootstrap brief](PI_LEAD_BOOTSTRAP.md)
- [Approved specification](.scratch/pi-lead/spec.md)
- [Ticket graph and index](.scratch/pi-lead/ticket-proposal.md)
- [First ticket: isolated fixture](.scratch/pi-lead/issues/01-isolated-fixture.md)
- [Second ticket: ChatGPT worker](.scratch/pi-lead/issues/02-chatgpt-worker.md)
- [Third ticket: validated proposed change](.scratch/pi-lead/issues/03-validated-proposed-change.md)
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

## Run the ChatGPT worker proofs

The extension admits a ChatGPT worker only for an explicit idle-session request:

```text
Lead: ask worker <question>
/lead-read <question>
Lead: ask worker --inputs CONTEXT.md,docs/adr/0001-isolate-first-real-worker.md -- <question>
/lead-read --inputs CONTEXT.md,docs/adr/0001-isolate-first-real-worker.md -- <question>
```

Ordinary chat, steering, follow-ups and extension-originated messages cannot create workers. Both admission forms use the same two-worker concurrency limit as `/lead-fixture`.

`--input`/`--inputs` explicitly selects one to three regular UTF-8 project files. Selection rejects absolute paths, traversal and symlinks, and caps the combined input at 12 KiB. The trusted Lead embeds those inputs in the bounded assignment; the guest still receives no project mount.

The worker runs the pinned native Pi JSON lifecycle in a Gondolin PTY inside the named Herdr tab and streams its native events there without taking Lead focus. The guest sees only synthetic provider placeholders. A trusted host hook refreshes and injects the ChatGPT OAuth bearer and account identity for the exact HTTPS `POST https://chatgpt.com/backend-api/codex/responses` request, rejects redirects, compressed responses and credential-bearing response headers or bodies, and never mounts the host filesystem. The streaming body guard detects credentials split across chunks before those bytes reach the guest. Cache warming and provider fallback are disabled. Success requires correlated native `agent_start`, authoritative assistant `message_end` and `agent_end` events; an idle or settled screen is not completion.

Run the credential-free proofs inside Herdr:

```bash
npm run chatgpt-fixture
npm run chatgpt-cancel-fixture
npm run chatgpt-reflection-fixture
```

The first proves a complete native Pi SSE turn against an in-memory fake upstream, including host-only credential injection and guest-storage scanning. The second proves cancellation before the provider call and zero upstream requests. The third makes the allowed upstream reflect the injected bearer across response chunks and proves that the host blocks it before it reaches Pi, guest storage remains clean and host artifacts remain redacted.

`npm run chatgpt-live` performs the minimal real subscription-backed proof. Do not run it until the operator has checked the current Codex usage dashboard and confirmed that no purchased or workspace credits can be consumed. OAuth readiness proves authentication only; it does not prove that usage cannot spill from included plan limits into credits. Quota exhaustion, refresh failure and model unavailability stop the worker with no API-key or paid-provider fallback.

Current runtime evidence covers macOS arm64 only. Ubuntu 24.04 and Linux arm64/x86_64 remain unrun. A missing/incompatible native Herdr pane identity is a feasibility blocker; the implementation does not fall back to host execution or weaken isolation.

## Request a validated proposed change

Use `/lead-change` with a named branch or tag, one or more mise task names, and every dependency destination the guest may contact:

```text
/lead-change --base main --check test --check typecheck --allow dl-cdn.alpinelinux.org --allow registry.npmjs.org -- update the requested behavior
```

The Lead transfers only the named committed base through a Git bundle into a private Gondolin workspace. The worker has no host mount or control socket. Git 2.52.0 and mise 2025.8.20 are installed from the explicitly allowed Alpine repository when absent; project tool downloads need their own `--allow` entries. A rejected destination blocks the task and never expands the allowlist automatically.

After the edit, the guest creates a synthetic proposal commit whose only parent is the selected base, resets to that exact commit for each declared `mise run <task>` check, and rejects a check that changes tracked content. The host imports the returned bundle into a fresh bare repository with system/global Git configuration, hooks, filters, external diffs and submodule recursion disabled. It collects bounded changed, added, deleted and renamed files, raw bytes, modes and confined symlink targets without checking out or executing guest content.

A successful command returns `REVIEW_REQUIRED`; it neither creates a host commit nor publishes anything. Review, correction and host commit belong to Ticket 04.

Run the credential-free macOS arm64 proofs inside Herdr:

```bash
npm run change-fixture
npm run change-denied-fixture
npm run change-mutating-check-fixture
```

The positive fixture executes its controlled edit process inside the VM and proves transfer, isolated mise validation, exact artifact collection, checkout preservation and confirmed cleanup. The negative fixtures prove a precise dependency denial with no policy expansion and rejection of a validation task that mutates the proposed tree. The real Pi/provider path reuses Ticket 02's host-mediated ChatGPT worker, but was not charged again for this ticket; Ubuntu 24.04 coverage remains assigned to Ticket 08.

## Controlled task-branch publication

After a validated implementation has passed its independent review and been delivered locally, the trusted host can publish only its exact `pi-lead/task-<task-id>` branch. Configure the consuming project's permitted remote in the trusted Lead environment, not in guest-visible worker inputs:

```bash
export PI_LEAD_GIT_REMOTE=origin
export PI_LEAD_GIT_REMOTE_URL=https://git.example.invalid/your-org/your-project.git
```

The name and exact URL form one trusted remote configuration; PI Lead does not read a repository-defined remote for publication. It never creates a remote, chooses among remotes, uses a force refspec, overwrites an existing different remote task branch, or publishes a protected/arbitrary branch. Before each attempt it records the exact intended remote/ref/commit in its host-owned run state; it records the observed result after reconciliation. A failed or unreconciled push leaves the reviewed local branch intact and reports `BLOCKED`; retrying starts by observing the remote branch again. PR creation, merges, deployment and privileged operations have no automatic publication path and remain human gates.

## Planning assets

The local tracker under `.scratch/` is intentionally versioned. The installed Matt skills under `.agents/skills/` and `skills-lock.json` preserve the workflow inputs used for this plan; this does not grant third-party code host privileges.

No GitHub repository, remote, external issue tracker or account setup is needed to review the plan. Request credentials or human-only setup only when a concrete implementation check needs them; never put secrets in the tracker or chat.
