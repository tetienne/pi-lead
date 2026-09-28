# 11: The Lead reattaches to live workers after a restart

**What to build:** If the Lead's Pi exits or crashes while workers run, a new Lead started in the same repository finds the workers still alive in Herdr and adopts them: they appear in `worker list`, their results arrive as usual, and the user can message or stop them. Workers whose Pi is gone are cleaned up as today.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] On start, a Lead adopts the workers of a previous Lead of the same repository whose pane still runs a Pi, instead of removing their worktrees (test).
- [ ] Adopted workers are listed, can be messaged and stopped, and their `finish` result is delivered to the new Lead (test).
- [ ] Workers whose pane or Pi is gone are removed as today, branch kept (test).
- [ ] Two Leads alive at once in the same repository never adopt each other's workers (test).
- [ ] README's lifecycle text no longer says there is no recovery.
- [ ] `npm test` and `npm run typecheck` pass.
