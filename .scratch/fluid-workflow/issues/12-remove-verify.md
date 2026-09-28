# 12: Remove the host-run verify command

**What to build:** PI Lead no longer runs a project `verify` command after a worker finishes. Verification is the project's own: its git hooks (e.g. prek) run on the worker's commits, and CI runs on the worker's draft PR, which the host already checks. The `verify` and `verifyTimeoutMinutes` settings, the worker-side run, the report's Verify line and the verify-failed send-back from ticket 04 are removed.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] No `verify` run happens after `finish`; the worker verify module and its tests are removed.
- [ ] `verify` and `verifyTimeoutMinutes` are gone from the config; old keys in either config file are ignored without a notice (test).
- [ ] Reports carry no Verify line; the "unverified" wording is replaced by what the host did check (CI on the PR head, or none).
- [ ] The verify-failed send-back is gone; the CI send-back stays (test).
- [ ] `finish` still commits with the project's hooks enabled for `done` (existing test kept).
- [ ] README's Verify section is replaced by one sentence on hooks and CI.
- [ ] `npm test` and `npm run typecheck` pass.
