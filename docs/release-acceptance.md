# Current release acceptance evidence

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
