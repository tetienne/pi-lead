# 08: ADR 0007 and docs

**What to build:** The design record and user docs describe the new flow. ADR 0007 records that the Lead implements single-session work, one worker per ticket runs `/implement` as written (no scout, no scope fence, no readiness gate), workers are plain Pi, and sub-agents run in Herdr panes. See [spec](../spec.md), "ADR 0007".

**Blocked by:** 01, 02, 03, 04, 05, 06, 07

**Status:** ready-for-agent

- [ ] `docs/adr/0007-*.md` exists with the decisions and their reasons (sandbox gone, Matt's `/tdd` vertical slices, review capacity, mattpocock/skills#561).
- [ ] README's "How it works", tools list, design record (0006 and 0007) and config reference match the code.
- [ ] CONTEXT.md glossary has no term for a removed mechanism.
- [ ] `npm test` and `npm run typecheck` pass.
