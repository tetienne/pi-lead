# 03: Narrow Jev to routing, overlap and verdict

**What to build:** A delegated ticket always starts: Jev no longer refuses tickets as "not ready". Jev is asked for the difficulty before start (tier routing), for overlap, and for the verdict after finish, nothing else. A launch failure is retried once without asking Jev; a review's fix hint always shows and the Lead decides. See [spec](../spec.md), "Readiness gate removed" and "Jev scope".

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `delegate` has no `confirmedReady` parameter and never returns `not_ready`; intake collapses into the tier call (test).
- [ ] `failureKind` is removed; a failed launch is retried exactly once regardless of Jev (test).
- [ ] `reviewSeverity` is removed; a review with findings always carries the "delegate an implement task" next step (test).
- [ ] The Jev kinds, ledger display and `/jev` list only the remaining judgments.
- [ ] Guidance and README no longer mention readiness or the removed judgments.
- [ ] `npm test` and `npm run typecheck` pass.
