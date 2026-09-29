---
status: accepted
---

# The Lead is an ordinary Pi conversation that acts through tools

PI Lead could have been a command-driven orchestrator that intercepts the
user's input and runs a fixed pipeline. Instead the Lead is a plain Pi
session with a short workflow section in its system prompt: the model
answers questions, follows Matt Pocock's own router for everything else
(ADR 0003, ADR 0007), and acts through three tools. `delegate` starts a
worker, `worker` lists, messages or stops workers, and `merge` merges green
PRs one at a time on the user's go-ahead. PI Lead never hooks the user's
input.

Delegation does not block: `delegate` returns once the worker is queued, and
each result arrives later as a message that wakes the Lead, so the Lead keeps
talking with the user while workers run. The worker's `finish` result, not
Herdr's view of the pane, decides when a worker is done. Jev answers only the
closed questions code cannot (the difficulty that picks a model tier, and a
check of the worker's verdict), within the policy of ADR 0002.

## Consequences

- Each worker's task directory holds a record of its Herdr workspace, pane
  and owning Lead. A Lead that starts in the same repository after its
  predecessor crashed adopts every worker whose Pi still runs (a done worker
  whose PR awaits merge included, so a merge-time problem still goes back to
  it), and removes the worktrees of the others (branches kept). A Lead never adopts the workers of
  another Lead that is still running.
