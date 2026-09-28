# 15: Sequence by Blocked-by, not by guessed overlap

**What to build:** Jev's pairwise overlap check is removed: it saw only ticket text, serialised every code-writing pair without a key, and a queued worker still started from the same base as the one it waited for, so it delayed conflicts rather than preventing them. Instead, the Lead sequences tickets by their explicit "Blocked by" edges: a blocked ticket is delegated only once its blockers' PRs are merged (ticket 10's merge flow), or started from a blocker's branch with `startFrom` when the user wants stacking. Every other ticket runs in parallel; conflicts surface and are resolved in the one-at-a-time merge flow. When a finished worker's changed files intersect another open worker PR's, the report says so.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] No overlap judgment remains: Jev's `overlap`, its cache and the "waits for overlapping" queue are removed; Jev kinds are `tier` and `verdict` (old ledger/decision entries still load if ticket 13 has not removed the ledger yet) (test).
- [ ] Two code-writing workers start in parallel with or without a Jev key (test).
- [ ] The Lead's guidance says: delegate a ticket only when its Blocked-by tickets are merged, or start it from the blocker's branch with `startFrom` when the user asks for stacking (test on the guidance text).
- [ ] A report whose changed files intersect another open worker PR's names the other ticket and the shared files (test).
- [ ] README no longer describes overlap scheduling.
- [ ] `npm test` and `npm run typecheck` pass.
