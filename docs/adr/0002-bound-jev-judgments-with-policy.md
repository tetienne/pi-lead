---
status: accepted
---

# Keep Jev judgments inside deterministic policy

Jev (TypeSafe, directly or through OpenRouter) answers closed-set questions,
and code maps each answer to an action; PI Lead does not let a model pick
permissions, model names or commands. Typed SDK responses prove neither
runtime validity nor semantic correctness, so answers are validated and
checked against a confidence floor. Below the floor, when Jev fails, or
without a key, a documented default applies (the `standard` tier; the
worker's own verdict). A Jev verdict can only make a report more pessimistic,
never better, and it is not asked at all when the host has already proven the
work (CI green on the PR head). PI Lead does not track or cap what Jev costs:
the user's TypeSafe or OpenRouter account does.
