# 02: One worker per ticket (remove the scout)

**What to build:** Delegating an `implement` ticket starts a single worker on the implement route, which runs Matt's `/implement` as written (test-first in vertical slices through `/tdd`, then `/code-review`). No scout phase, no allowed-files list, no scope fence, no scope widening to approve. See [spec](../spec.md), "Scout removed".

**Blocked by:** 01

**Status:** ready-for-agent

**Resolution:** DONE

- [x] An `implement` delegation starts exactly one worker; no `scout` work kind, tier or phase remains (test at the delegator seam).
- [x] The worker extension no longer blocks write/edit on a brief, and `finish` no longer requires an allowed-files list.
- [x] The `worker` tool no longer accepts a scope widening; a report is never capped to `partial` for out-of-scope files or edited scout tests.
- [x] The report card and report text no longer show scout or scope lines.
- [x] Guidance, README and CONTEXT.md no longer describe scouting.
- [x] `npm test` and `npm run typecheck` pass.
