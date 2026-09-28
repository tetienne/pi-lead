# 16: ADR cleanup, ADR 0007 and docs

**What to build:** The design record and user docs describe the new flow. ADR 0007 records that the Lead implements single-session work, one worker per ticket runs `/implement` as written (no scout, no scope fence, no readiness gate), workers are plain Pi, and sub-agents run in Herdr panes. See [spec](../spec.md), "ADR 0007".

The ADRs are cleaned up in the same pass: every ADR states what is true after this effort, in Matt's short format (.agents/skills/domain-modeling/ADR-FORMAT.md: context, decision, why; optional sections only when they add value). Implementation detail that belongs in the code or README leaves the ADRs. The repository edits ADRs in place (git keeps history), so numbers stay stable.

**Blocked by:** 01–15

**Status:** ready-for-agent

- [ ] ADRs 0001–0005 are rewritten to the current truth in short form: 0001 (Lead routes, reattaches to live workers after a restart since ticket 11, `delegate`/`worker`, Jev's remaining judgments), 0002 (Jev bounded by policy, without a spend budget since ticket 13), 0003 (workers are plain Pi with the user's extensions, Lead inert under the marker, no waiting timeout, workspace lifecycle in one or two sentences), 0004 (retired or rewritten: verification is the project's own hooks, e.g. prek, and CI, since ticket 12), 0005 (unchanged unless stale).
- [ ] ADR 0006 is broadened to "no fences around host workers" (Lead guard, scope fence and host-check anti-evasion), or kept and cross-referenced; no two ADRs contradict each other.
- [ ] `docs/adr/0007-*.md` exists with the decisions and their reasons (sandbox gone, Matt's `/tdd` vertical slices, review capacity, mattpocock/skills#561); and its limit: these choices assume a developer at their own machine with a human in the loop. Running PI Lead headless or in CI would need a sandbox and scoped credentials again (see claude.com/blog/the-ai-native-sdlc-playbook).
- [ ] README's "How it works", tools list, design record (0006 and 0007) and config reference match the code.
- [ ] The `.scratch/fluid-workflow/` directory is deleted in the last commit (its decisions live in the ADRs and README), as #40 did for `.scratch/pi-lead/`.
- [ ] CONTEXT.md glossary has no term for a removed mechanism.
- [ ] `npm test` and `npm run typecheck` pass.
