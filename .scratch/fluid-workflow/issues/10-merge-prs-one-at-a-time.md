# 10: Merge green PRs one at a time

**What to build:** When the user asks (for one PR, or once for a whole spec: "merge them as they turn green"), the Lead merges workers' green PRs itself, one at a time, in ticket order. After each merge, the next PR is brought up to date with its base and must be green again on its new head before it is merged. A conflict or a red CI after the update goes back to that PR's worker (or, if the worker is gone, is reported to the user). The Lead never merges without the user's go-ahead. Matt's issue #493 (see research-ecosystem.md) is the motivation: parallel branches merged at once break each other.

**Blocked by:** 04, 07

**Status:** ready-for-agent

- [ ] Read `gh pr merge --help`, `gh pr update-branch --help` and `gh pr checks --help` first and use gh's own features (merge method from the repository's settings, branch update, check watching) rather than re-implementing them.
- [ ] The Lead's guidance describes the merge flow and the go-ahead rule (test on the guidance text).
- [ ] Merges happen strictly one at a time; the next PR is updated from base and waits for green CI on its new head before merging (test at the delegator/tool seam, with fake gh).
- [ ] A conflict or red CI after an update is sent to the PR's worker if it is still open, otherwise reported to the user (test).
- [ ] A merged PR's worker workspace is closed; the branch follows the repository's delete-on-merge setting.
- [ ] README describes the flow.
- [ ] `npm test` and `npm run typecheck` pass.
