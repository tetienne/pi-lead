---
status: accepted
---

# The Lead is an ordinary Pi conversation that delegates through one tool

1. **The Pi model routes, not the extension.** PI Lead does not hook `input`.
   A question is simply answered; for anything else the model follows the
   workflow guidance (ADR 0003) and decides what to do.
2. **Delegation is a tool.** `delegate` is the only way work leaves the Lead
   conversation. Its result (summary, branch, diff stat, verdict) returns to
   the model, so the Lead knows what its workers did.
3. **Matt skills ship with the package** and are loaded natively by Pi. Skills
   with `disable-model-invocation` are invoked explicitly: by the Lead's
   workflow guidance, or as `/skill:<name>` in the worker's first message.
4. **Workers are visible Pi sessions in Herdr.** One `--no-focus` worktree
   workspace per worker runs an interactive `pi` process on the model and
   thinking level of the tier the Lead picked (`fast`, `standard` or `deep`). The worker ends by calling `finish`; the Lead waits for that result
   file and collects the branch.
5. **The Lead model judges; the worker's gates decide completion.** There is
   no separate judge model (ADR 0002 is superseded by ADR 0006).

## Consequences

- Herdr is presentation; the Lead owns completion through the worker's
  `finish` result. There are no durable task records or restart recovery: an
  interrupted worker leaves its workspace and branch for the human to inspect.
