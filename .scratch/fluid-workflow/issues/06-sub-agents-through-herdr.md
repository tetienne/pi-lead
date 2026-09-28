# 06: Sub-agents through Herdr

**What to build:** When a skill asks for a sub-agent (code-review's two axes, grilling's fact-finding, wayfinder research, improve-codebase-architecture's exploration, codebase-design), the Lead or the worker starts one as a non-interactive Pi in a Herdr pane split beside it, without focus and with the PI Lead marker set, waits for it, reads its report file and closes the pane. Without Herdr, it runs the sub-agent steps one after the other in the same context and says so. See [spec](../spec.md), "Sub-agents through Herdr".

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The Lead's guidance carries the recipe, using Herdr 0.9.1 commands (`pane split --current --no-focus`, `pane run`, `pane wait-output`) and the marker (test on the guidance text).
- [ ] The worker rules carry the same recipe (test on the worker prompt/rules).
- [ ] The guidance no longer tells the Lead to do improve-codebase-architecture's exploration itself instead of a sub-agent.
- [ ] The recipe says what to do without Herdr (sequential fallback, stated in the output).
- [ ] `npm test` and `npm run typecheck` pass.
