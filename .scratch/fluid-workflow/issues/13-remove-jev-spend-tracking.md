# 13: Remove Jev spend tracking

**What to build:** PI Lead no longer tracks or caps what Jev costs. The daily budget, the file-backed ledger, the per-kind counts, the charge queue, the polling timer and the status-bar spend segment are removed. Jev keeps answering its three judgments; `/jev` shows only this session's recent decisions (or is removed if nothing useful remains).

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] No ledger file is read or written; `dailyBudgetUsd` and `inputUsdPerMillion` are gone from the config, old keys ignored without a notice (test).
- [ ] Jev is never refused for budget reasons; the "over budget" notice is gone (test).
- [ ] No timer or status segment for spend remains; `/jev` shows recent decisions only, or is removed (test on registered commands).
- [ ] README no longer mentions a Jev budget.
- [ ] `npm test` and `npm run typecheck` pass.
