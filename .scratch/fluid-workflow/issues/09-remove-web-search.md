# 09: Remove web_search from PI Lead

**What to build:** Workers get web access the same way the user's Lead does: through the user's own Pi extensions, which load in workers since ticket 05. PI Lead no longer ships its own web search tool or the ChatGPT-subscription plumbing behind it.

**Blocked by:** 05

**Status:** ready-for-agent

- [x] The worker extension no longer registers `web_search`; its module and tests are removed.
- [x] Worker rules and prompts no longer mention `web_search`.
- [x] README's "Web access for workers" section is replaced by one sentence: workers use the user's own extensions.
- [x] `npm test` and `npm run typecheck` pass.

**Resolution:** DONE
