---
status: accepted
---

# The Lead chooses each worker's model and thinking level

A worker's model used to come from a tier (`fast`, `standard`, `deep`) that
Jev picked from a difficulty score, each tier mapped to configured models
with fallbacks; Jev also checked the worker's verdict (ADR 0002). Now
`delegate` requires a `model`, a `thinking` level and a one-sentence `why`, and
PI Lead only checks that Pi can use the model now: authenticated
(and in the session's scope, when there is one) and its provider not out of
quota. Each prompt lists those models with their prices, and a one-line rule of thumb says when
to pick a cheaper or a stronger one. A worker's status is its own, capped only
by host evidence: its PR and CI on the branch head.

Why: by the time it delegates, the Lead has grilled the user, read the ticket
and usually the code, so it knows how hard the work is; Jev saw only the
ticket text. Dropping Jev also removes a dependency, an API key and a few
seconds of latency per delegation, and the `tiers` and `jev` settings go with
it (old keys are ignored). A verdict check on text alone rarely beat the host's
CI evidence, which stays.

The parameters are required, with prices in the list, because when they were
optional the Lead omitted the model in 35 of 36 delegations and every worker
ran on its own model. The `why` makes it state the fit.

Separately, the `reviewModel` setting runs code-review's sub-agents on a
configured model. It is distinct from worker routing: it never changes a
worker's model, and a failing review model is reported, not rerouted.

A quota error no longer reroutes on its own: there are no configured
fallbacks to reroute to. The worker reports `blocked` with its branch, its
provider is refused until its quota resets, and the Lead delegates the same
ticket again at once from that branch on another provider's model; that
worker inherits the first one's ticket base, PR base and remote branch, so it
continues the same PR.

## Consequences

- The choice is only as good as the Lead's model: a weak Lead may send hard
  work to a cheap model, or everything to its own. The worker's status and CI
  still catch work that falls short, and the user can always name a model.
