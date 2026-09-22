---
status: accepted
supersedes: 0001 (worker shape), 0002, 0004
amends: 0003
---

# The Lead is an ordinary Pi conversation that delegates through one tool

Decided 2026-09-22 after a scope review found that the extension had drifted
from its brief: natural-language requests were intercepted by regular
expressions before the model saw them, several workflows still required
`--base/--spec/--check` flags, Jev classified intent instead of choosing
models, only three Matt skills were ever invoked, and roughly 10 000 of 12 000
lines served whole-Pi VM isolation, ChatGPT credential mediation, an unused
second provider, publication, scheduling and recovery journals.

## Decision

1. **The Pi model routes, not the extension.** PI Lead no longer hooks `input`.
   A question is simply answered. The Lead's system prompt gains a short
   workflow section (Matt's idea → grilling → spec → tickets → implement flow,
   diagnosis for bugs, review for branches) and the model decides what to do.
2. **Delegation is a tool.** `delegate` is the only way work leaves the Lead
   conversation. Its result (summary, branch, diff stat, verdict) returns to
   the model, so the Lead knows what its workers did.
3. **Matt skills ship with the package** and are loaded natively by Pi. Skills
   with `disable-model-invocation` are invoked explicitly: by the Lead's
   workflow section, or as `/skill:<name>` in the worker's first message.
4. **Workers are visible Pi sessions in Herdr tabs.** One `--no-focus` tab per
   worker runs an interactive `pi` process with a Jev-chosen model and thinking
   level. The worker ends by calling `finish`; the Lead waits for that result
   file, collects the branch and closes the tab (kept open on failure).
5. **Gondolin isolates what the model can do, not Pi itself.** The worker's Pi
   runs on the host with `--no-extensions --no-builtin-tools --no-approve`,
   plus one trusted extension that re-registers `read`, `write`, `edit`,
   `bash`, `ls`, `find` and `grep` inside a Gondolin VM. The VM mounts a
   throw-away local clone of the repository at `/workspace`; no host home,
   credential, socket or original checkout is mounted. No provider secret ever
   enters the guest, so every Pi provider and subscription works for workers.
   The host brings work back with `git fetch` from that clone, never by running
   git inside it.
6. **Jev judges, code decides.** Jev (TypeSafe `jev-latest` via the official
   SDK, directly or through OpenRouter) answers closed-set questions whose
   answers map to deterministic actions: model tier, ticket readiness, egress
   requests, worker verdicts, review severity, failure kind and ticket overlap.
   Below the confidence floor, or when Jev is not configured, the code falls
   back to a documented default or asks the human. Spend is bounded by a
   single daily budget setting.

## Consequences

- ADR 0001's requirement that *all worker execution* happens behind a VM
  boundary still holds for model-driven actions; the trusted Pi agent loop and
  this package's extension code now run on the host. The trust assumption is
  that Pi, this package and the provider SDKs are not compromised; model output
  can only act through the sandboxed tools.
- Herdr is used for presentation and the Lead owns completion through the
  worker's `finish` result (ADR 0002's durable task records and restart
  recovery are dropped; an interrupted worker leaves its tab and clone for the
  human to inspect).
- The previous `src/` tree (Gondolin-hosted Pi, ChatGPT OAuth placeholder
  injection, OpenCode Go, publication, dependency scheduler, host matrix,
  toolchain caches, fixture harnesses and task journals) is removed. It stays
  available in git history before this ADR.
- The approved spec at `.scratch/pi-lead/spec.md` is superseded by
  `.scratch/pi-lead/spec-v2.md`.
