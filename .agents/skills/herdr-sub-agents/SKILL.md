---
name: herdr-sub-agents
description: Run the sub-agents a skill asks for (code-review's two axes, grilling's fact-finding, wayfinder's research, improve-codebase-architecture's exploration, codebase-design's design-it-twice) as non-interactive Pi processes in Herdr panes. For the Lead and for workers alike.
---

# Herdr sub-agents

When a skill says to spawn, dispatch or fire a sub-agent (code-review's two
axes, grilling's fact-finding, wayfinder's research,
improve-codebase-architecture's exploration, codebase-design's
design-it-twice), run each one as a non-interactive Pi in a pane beside you.

1. No Herdr (`test "${HERDR_ENV:-}" = 1` fails): do the sub-agents' steps
   yourself, one after the other, and say so.
2. Write each sub-agent's complete brief to `<dir>/prompt.md` in a fresh
   `mktemp -d`: it sees nothing of your context.
3. Open its pane (`down` instead of `right` if your pane is narrow):

   ```sh
   SUB=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | jq -r .result.pane.pane_id)
   ```

4. Start it. Start every sub-agent the step asks for before waiting on any:

   ```sh
   herdr pane run "$SUB" "pi --print --no-session @<dir>/prompt.md > <dir>/report.md 2>&1; echo sub-agent-finished"
   ```

5. Wait, then read and close:

   ```sh
   herdr pane wait-output "$SUB" --source recent-unwrapped --regex '^sub-agent-finished' --timeout 1800000
   cat <dir>/report.md
   herdr pane close "$SUB"
   ```

   On a timeout, look with
   `herdr pane read "$SUB" --source recent-unwrapped --lines 120` before deciding.
