# Release acceptance evidence

## Refocused Ticket 20 acceptance — 2026-09-22

This section records evidence against the conversation-first contract from base
revision `cae134c9a59589bd296d5ab1bbf43839bce96a11`. It establishes Ticket 20
DONE for the approved macOS arm64/ChatGPT Pro boundary and states the live
limits observed during acceptance.

### Environment and deterministic checks

The host is macOS arm64 (`Darwin arm64`) with Node 24.14.1, npm 11.11.0, the
repository-pinned Pi 0.86.1, Herdr 0.8.0 and Gondolin 0.12.0. The final
`npm test` passed all 153 tests in 6.667 seconds and `npm run typecheck`
passed. The suite covers
the unified intent surface, unavailable/malformed/ambiguous/stale and
over-budget Jev outcomes, model-route verification, implementation, debug,
read-only review, recovery, result correlation and cleanup policy.

### Fresh consuming-project activation

The final `npm pack --dry-run --json` reported a 39-file `pi-lead@0.1.0`
archive (78,681 bytes packed, 327,390 bytes unpacked, SHA-1
`9acba21d8b7677e2230588ccd975fbf4f90d9cd4`).
Registering the `.tgz` itself with `pi install -l` exposed a documentation bug:
Pi stored the archive path as an extension and then rejected its `.tgz` file
type. The corrected local-artifact flow installs the archive and dependencies
into a staging directory, then activates `stage/node_modules/pi-lead`; README
instructions and the package regression test now use that shape.

A fresh consuming project loaded that staged archive through Pi 0.86.1. Native
RPC discovery reported `lead` as the package's only extension command. Ordinary
requests—“Implement a new welcome screen”, “Debug this startup crash” and
“Review this branch”—entered the same Lead seam and returned the expected
conversational requests for approved spec/base/check or review context; none
asked for a provider, skill or lifecycle stage. “How are you?” stayed in the
Lead and, with provider access deliberately offline, failed at the Lead's own
model gate without creating a PI Lead task record or worker.

### Credential-free isolated runtime

- `npm run chatgpt-fixture` completed in 3.898 seconds with one mediated fake
  provider request; native `agent_start`, `message_end`, `agent_end` and
  `agent_settled` events were correlated, the answer was collected and VM
  termination was confirmed.
- `npm run change-fixture` completed in 4.493 seconds with a correlated
  `REVIEW_REQUIRED` proposal, a passing isolated `mise run test`, exact changed
  file collection, a preserved host checkout, cold private toolchain storage
  and confirmed VM termination. It correctly made no host commit or
  publication claim.
- The post-run Herdr inventory contained no tab from either successful fixture.
  Two older retained diagnostic tabs (`OpenCode Go read-only worker` and
  `isolated fixture`) predate this run and are not presented as Ticket 20
  cleanup failures.

### Live unified Lead evidence

After the operator confirmed that current ChatGPT usage could not consume
purchased or workspace credits, the session-scoped
`PI_LEAD_CHATGPT_INCLUDED_QUOTA_CONFIRMED=yes` gate was enabled. A disposable
consuming repository was activated project-locally and submitted this ordinary
request through native Pi input:

```text
--base main --check test --allow dl-cdn.alpinelinux.org --spec spec.md -- Change value.txt from before to after. Do not change any other tracked file.
```

Task `bffb63e8-851b-4c2d-8fa4-31768594e7e1` completed in 103.950 seconds. The
Lead selected and verified `openai-codex/gpt-5.6-luna` at `high` reasoning for
the build and both reviewers. The isolated build changed only `value.txt`,
passed `mise run test`, collected artifact
`07b77ea02ab2779798862c826579e02417f98bd4a51d3eda067cd977173fdcf7`,
and confirmed VM termination. Independent Standards and Spec reviewers returned
no findings in separate contexts. The Lead created local branch
`pi-lead/task-bffb63e8-851b-4c2d-8fa4-31768594e7e1` at commit
`a89b128168cac76a676a83df8ef43116587232b4`, preserved the active `main`
checkout, collected all results, confirmed all three VM terminations and tab
closures, and correctly left publication deferred.

The same Lead interface admitted a structured debug request. Its feedback
worker failed closed with `Dependency destination mise.jdx.dev is not
explicitly allowed`; repeating the request with that exact host present in the
recorded allowlist produced the same result. Both attempts terminated their VMs
and retained stopped diagnostic tabs as policy requires. This is an explicit
live debug limitation, not a successful-debug claim.

A structured read-only review of the delivered branch then completed as task
`b62875d2-fa07-4ff3-8789-78a8f92f1fff`. One explicit retry followed a provider
`502 Bad Gateway` that produced no output tokens and no automatic replay. The
successful attempt produced independent Standards and Spec reports with no
findings, confirmed unchanged worktree and refs, pinned final commit
`a89b128168cac76a676a83df8ef43116587232b4`, terminated both VMs and closed
both successful tabs. Publication remained false.

Acceptance drove three corrections: the local archive activation instructions
now stage dependencies before Pi activation; the deterministic Jev-outage
fallback distinguishes structured debug/review requests from implementation;
and the durable review journal accepts the native three-dot Git comparison when
pinning its final commit.

### Open human gates and explicit limits

The dedicated Jev environment was not configured in this session, so no live
OpenRouter judgment was attempted. That is the existing credential gate, not a
reason to weaken the $1/day cap; the deterministic outage and bounded-budget
outcomes above remain truthful.

ChatGPT admission remains a per-session human gate. The live proof above ran
only after explicit included-only confirmation; future sessions must make that
current confirmation again.

The final Herdr inventory contained no successful Ticket 20 worker tab. It did
retain the two debug diagnostic tabs and the failed `502` reviewer tab described
above, alongside two older historical diagnostics. Retention is intentional for
failed/BLOCKED work and does not keep a VM alive. Their disposable consuming
checkout and host-owned state remain under `/tmp/pi-lead-ticket20-live.diYsTP`
and `/tmp/pi-lead-ticket20-live-state*` until those diagnostics are explicitly
cleared.

Ubuntu, OpenCode Go, publication, cache optimization and advanced dependency
scheduling remain deferred and were not run or inferred from these macOS
results.

## Historical broad-program acceptance evidence

Superseded on 2026-09-22 by the refocused product contract in
[Ticket 17](../.scratch/pi-lead/issues/17-refocus-product-contract.md). This
document preserves the runtime and packaging evidence gathered for Ticket 16;
it does not establish acceptance of the conversation-first Lead interface.
Ticket 20 owns current release acceptance.

Recorded 2026-09-22 for the approved current scope: macOS arm64 and ChatGPT
Pro. This is an evidence record, not a compatibility claim for a host or
provider that was not run.

## Packaging and project activation

The final local `npm pack --dry-run --json` reported `pi-lead@0.1.0`, 48 files,
an unpacked size of 391,554 bytes, and SHA-1 `e97ff015581c385d88f1d48a447577b11117bd9a`.
The package was packed locally as `pi-lead@0.1.0` and installed from that
archive into a newly created consuming project with the repository's pinned Pi
0.86.1 binary. The initial `pi install -l ... --no-approve` was rejected;
the same install with `--approve` succeeded and wrote only the consuming
project's `.pi/settings.json`. A second fresh consuming project remained
empty. `PI_CODING_AGENT_DIR` and session storage were redirected to a temporary
directory, and no saved trust decision was created there.

The archive is a local source, not a native Pi version pin: Pi treats
filesystem paths as mutable local package sources. It establishes that the
package is release-ready locally and that project trust is explicit, but it
does not establish install/upgrade of a published `npm:name@version` or
`git:...@commit` package. Publication or creation of such a destination is an
existing human gate and was not attempted.

## Runtime evidence

All commands below used Node 24.14.1, the repository's Pi 0.86.1 dependency,
Gondolin 0.12.0, and macOS arm64. The first fixture invocation was denied by
the execution sandbox while creating Gondolin's local virtio socket. Re-running
the identical fixture with the required local-VM permission passed; this is an
execution-environment constraint, not a passing result from the denied run.

- `npm run chatgpt-fixture` completed an isolated fake ChatGPT native Pi turn:
  one mediated request, correlated `agent_start`, `message_end`, `agent_end`,
  and `agent_settled` events, and confirmed VM termination. Wall time was
  3.983 seconds.
- `npm run chatgpt-cancel-fixture` recorded cancellation before the provider
  call, observed zero mediated requests, and confirmed VM termination. Wall
  time was 2.212 seconds.
- `npm run chatgpt-reflection-fixture` blocked a credential reflected across
  stream chunks before guest-visible output and confirmed VM termination. Wall
  time was 4.006 seconds.
- `npm run change-fixture` produced a correlated `REVIEW_REQUIRED` proposal,
  passed `mise run test`, preserved the host checkout, and confirmed VM
  termination. It correctly remained at the review human gate rather than
  claiming a commit or publication.
- A paired cold/warm proposed-change fixture measured cold preparation at
  2178.246 ms and warm preparation at 2067.044 ms. Warm mise readiness regressed
  from 21.243 ms to 396.529 ms, and validation moved from 13.515 ms to
  14.595 ms. The recorded conclusion is `NO_IMPROVEMENT`; cache promotion is
  not justified by this measurement.

The live macOS ChatGPT Pro result remains the correlated evidence recorded in
[Ticket 02](../.scratch/pi-lead/issues/02-chatgpt-worker.md): it was run only
after the operator confirmed no paid-credit fallback, collected its artifact,
and confirmed successful tab cleanup. This acceptance run did not repeat a
paid/provider-authenticated request.

## Deterministic final coverage

Final local validation of code revision `a5c3eca` passed `npm test` (138 tests),
`npm run typecheck`, and `git diff c14c7b8...HEAD --check`. Independent
Standards and Spec reviews corrected the current-release matrix to require both
macOS arm64 and ChatGPT Pro evidence. It now blocks a macOS scenario carrying
OpenCode Go evidence. The broader host matrix remains provider-neutral for
future supported-host work.

The deterministic suite covers lifecycle, isolation, ChatGPT policy, review/fix,
publication, routing budget, dependency scheduling, recovery, retention, and
current-release deferrals. It does not turn those controlled seams into an
unrun final Herdr/provider/retention acceptance claim.

## Explicit limits and remaining human gates

- Ubuntu 24.04 LTS x86_64 and arm64 remain deferred; no current-release
  compatibility claim is made.
- A successful OpenCode Go worker remains deferred until included quota returns;
  paid balance is not a fallback.
- A fresh install from a true native Pi pin (`npm:name@version` or
  `git:repository@commit`) and that pin's upgrade path require a user-approved
  publication destination. The local archive is retained as the local release
  artifact while that gate remains open.
- The native Herdr fixture requires a real Lead pane (`HERDR_PANE_ID`). Its
  prior correlated macOS evidence is recorded in the completed tickets; this
  unattended acceptance session did not create or select a user tab.
