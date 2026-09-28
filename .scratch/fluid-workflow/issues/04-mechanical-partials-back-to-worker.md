# 04: Mechanical partials go back to the worker once

**What to build:** When a worker finishes and the host caps its report to `partial` only because CI failed or is pending, or `verify` failed, the host sends the evidence back to the same worker once, automatically, and the user hears about it only if the next report is still not done. The PR check counts CI only on the worker's branch head. The Jev verdict check is skipped when the host has already proven the work. See [spec](../spec.md), "Mechanical partials go back to the worker once", "PR head check", "Jev scope".

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A first CI-failed/CI-pending/verify-failed partial is sent back to the worker with the host evidence and is not reported to the user as a question (test).
- [ ] A second such partial, or any `needs_human`/`blocked`, reaches the Lead as today (test).
- [ ] A PR whose head commit differs from the worker branch head counts as pending (test).
- [ ] No Jev verdict call is made when verify passed (or none is configured) and CI passed on the head (or the repository has no checks) (test).
- [ ] `npm test` and `npm run typecheck` pass.
