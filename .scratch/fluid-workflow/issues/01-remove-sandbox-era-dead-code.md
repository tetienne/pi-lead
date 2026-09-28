# 01: Remove sandbox-era dead code and the waiting timeout

**What to build:** PI Lead behaves exactly as today for the user, except that a worker waiting on the user's answer now waits until answered or stopped. Code that only made sense while workers ran in a sandbox, or that no caller reaches, is gone, and debug/review start at the tier the README documents when Jev gives no difficulty. See [spec](../spec.md), "Dead code", "Waiting timeout removed", "Default tier", and the Jev settings no longer sent to workers.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Jev's egress judgment is gone: no `egress` method, no `egress` kind in the ledger, `/jev` or the display filter, no egress cache or charge-queue comment written for it.
- [ ] The worker task no longer carries the Jev settings; comments saying workers share Jev or its budget are corrected.
- [ ] The legacy Herdr metadata fallback (without `--seq`) and the tab-rename switch-off are removed; Herdr 0.9.1 stays the documented minimum. Stale "workers never receive the Herdr socket" comments are corrected.
- [ ] The context snapshot no longer rejects symlinks or enforces size/file budgets; it still copies the project's resources for trusted projects only.
- [ ] The host check keeps its pattern list as a review hint but drops the anti-evasion parts (symlinked parents, case folding, the `package.json` scripts diff and the file-at-revision helper only it uses).
- [ ] `waitingTimeoutMinutes`, its timer, the "stopped after N minutes" note and the "timed out" report are removed; an old key in a config file is ignored without a notice (test).
- [ ] With no Jev difficulty, debug and review start at `standard` (test).
- [ ] README config example and text no longer mention removed settings or mechanisms.
- [ ] `npm test` and `npm run typecheck` pass.
