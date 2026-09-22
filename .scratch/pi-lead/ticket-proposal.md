# PI Lead ticket graph

Status: the original 16-ticket program has been audited. The user approved the
17 → 18 → 19 → 20 cleanup sequence on 2026-09-22. Ticket 17 is DONE and defines
the authoritative refocused contract; Ticket 18 is the current frontier.
Unfinished historical tickets must not be resumed independently.

Source: [approved specification](spec.md), interpreted with the original
[bootstrap brief](../../PI_LEAD_BOOTSTRAP.md) and the approved cleanup tickets.
Each linked ticket remains the authoritative record of its scope, evidence and
current delivery status.

## Ticket index

| Ticket | Status | Blocked by | Outcome |
| --- | --- | --- | --- |
| [01: Install a Lead and complete an isolated fixture task](issues/01-isolated-fixture.md) | ready-for-human; resolved DONE | None | Proved the first isolated visible worker lifecycle. |
| [02: Complete a ChatGPT Pro read-only worker task](issues/02-chatgpt-worker.md) | ready-for-human; resolved DONE | 01 | Proved a bounded isolated ChatGPT worker with host-mediated credentials. |
| [03: Return a validated proposed change from a private workspace](issues/03-validated-proposed-change.md) | ready-for-human; resolved DONE | 02 | Returned a checked proposal without changing the host checkout. |
| [04: Review, fix and commit a complete local coding task](issues/04-review-fix-commit.md) | ready-for-human; resolved DONE | 03 | Built the reviewed local coding lifecycle currently reached through a specialized command. |
| [05: Push validated task branches through explicit policy](issues/05-controlled-push.md) | ready-for-human; resolved DONE | 04 | Built controlled task-branch publication as an internal capability. |
| [06: Recover interrupted work and retain useful diagnostics](issues/06-recovery-retention.md) | wontfix (superseded by 18) | 05 | Recovery is implemented and tested but is not connected to the main Lead. |
| [07: Reuse safe toolchain caches across repeated tasks](issues/07-safe-toolchain-caches.md) | ready-for-human; resolved DONE | 03 | Proved isolated cache seeds and recorded that the measured warm path did not improve. |
| [08: Run the isolated task path on both Linux architectures](issues/08-linux-hosts.md) | ready-for-human (deferred) | 02 | Deferred Linux evidence; not part of the current release claim. |
| [09: Use OpenCode Go when included quota is available](issues/09-opencode-go.md) | ready-for-human (deferred) | 02 | Provider adapter exists, but a successful included-quota run remains deferred. |
| [10: Route natural-language intent through bounded Jev calls](issues/10-jev-intent-routing.md) | wontfix (superseded by 18) | 02 | Deterministic routing exists; bounded live Jev evaluation transfers to Ticket 18. |
| [11: Select allowed models and reasoning at worker spawn](issues/11-model-reasoning-routing.md) | wontfix (superseded by 18) | 10 | Selection policy exists but has no production caller at worker spawn. |
| [12: Turn an idea into approved specs and vertical tickets](issues/12-idea-to-tickets.md) | ready-for-human; resolved DONE | 02 | Planning reaches installed Matt skills, though its command surface will be contracted. |
| [13: Diagnose bugs and review existing branches](issues/13-debug-and-review.md) | wontfix (superseded by 18) | 04 | Lifecycles exist but are unreachable from the main Lead interface. |
| [14: Triage incoming work and resolve large design maps](issues/14-triage-and-wayfinding.md) | ready-for-human; resolved DONE | 12 | Natural-language routing reaches the installed Matt triage and wayfinding skills. |
| [15: Execute the dependency frontier with two workers](issues/15-dependency-scheduler.md) | wontfix (deferred) | 04, 06, 12 | Scheduler logic is tested but excluded from the refocused current release. |
| [16: Verify reusable installation and the current release experience](issues/16-complete-acceptance.md) | wontfix (superseded) | 07, 11, 13, 14, 15 | Broad-program acceptance is replaced by Ticket 20. |
| [17: Refocus the product contract on one Lead interface](issues/17-refocus-product-contract.md) | ready-for-human; resolved DONE | None | Defines the conversation-first interface and classifies every existing capability. |
| [18: Execute Matt workflows through one orchestrator](issues/18-unified-orchestration.md) | ready-for-agent | 17 | Connect useful intents, Jev judgments, Matt skills and worker lifecycles behind one interface. |
| [19: Contract the public surface and remove orphan paths](issues/19-contract-public-surface.md) | ready-for-agent | 18 | Remove provider/skill/stage commands and exclude unexplained feature islands. |
| [20: Validate the refocused product in a consuming project](issues/20-refocused-product-acceptance.md) | ready-for-agent | 19 | Prove the complete conversation-first macOS/ChatGPT experience. |

## Refocused dependency overview

```mermaid
flowchart LR
  A[17 Product contract] --> B[18 Unified orchestration]
  B --> C[19 Contract public surface]
  C --> D[20 Refocused acceptance]
```

Ticket 18 reuses and reconciles the partial implementations recorded by Tickets
06, 10, 11 and 13 alongside the completed workflow evidence in Tickets 12 and
14. Ticket 19 excludes Ticket 15 and the other deferred modules from
the active package path according to the contract established by Ticket 17.
These are integration inputs and cleanup obligations, not parallel permission
to expand the public surface again.

## Scope disposition

| Area | Disposition |
| --- | --- |
| Isolation, credential mediation, deterministic policy, correlated results, validation/review and cleanup | Retain as core safety implementation behind the Lead. |
| Jev intent/resource judgment and Matt workflows | Integrate behind the single conversation-first interface in Ticket 18. |
| Public interaction | Ordinary Lead conversation plus the sole `/lead <request>` escape hatch; no provider, skill, fixture or lifecycle-stage command is product surface. |
| Provider-, skill-, fixture- and lifecycle-stage commands | Compatibility or development evidence only until removal from command discovery by Ticket 19. |
| Recovery and diagnostic retention | Current product core; Ticket 18 connects it behind the orchestrator. |
| Automatic publication | Deferred; the current release ends at validated, reviewed local task-branch commits. |
| Dependency-frontier scheduling | Deferred; the two-worker limit remains available within a single task and its independent review. |
| Cache optimization | Deferred after the measured warm path failed to improve; private writable storage remains a security invariant. |
| Linux and OpenCode Go acceptance | Deferred; no current compatibility/provider-success claim. |
| Local activation and current provider | macOS arm64 with ChatGPT Pro; Jev remains bounded by deterministic policy and its configured $1/day ceiling. |
| Broad 16-ticket release acceptance | Superseded by focused Ticket 20 acceptance. |

## Approval and execution

The user approved the four-ticket cleanup granularity and blocking edges on
2026-09-22. Tickets 18–20 must proceed in order. This approval authorizes
tracker publication only; each implementation ticket still follows its own
execution gate, validations and human gates.
