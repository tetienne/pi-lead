---
status: accepted
---

# Keep Jev judgments inside deterministic policy

Jev (TypeSafe, via the official SDK, directly or through OpenRouter) answers
closed-set questions; PI Lead keeps admission and completion decisions in
code. Typed SDK responses do not prove runtime validity or semantic
correctness, and confidence fields may be missing: constrain candidates,
validate responses and recheck the current state before acting. Below the
confidence floor, or when Jev is not configured, the code falls back to a
documented default or asks the human. Spend is bounded by one daily budget
setting, an upper bound rather than a target. This deliberately limits
autonomous judgment instead of letting Jev pick permissions, model names or
commands freely.
