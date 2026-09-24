---
status: accepted
---

# Workers mirror the Lead; Matt's router drives the Lead

1. **ask-matt is the Lead's router.** For anything that is not a plain
   question, the Lead reads Matt Pocock's `ask-matt` skill and follows the
   flow it names. Execution skills (`implement`, `prototype`,
   `diagnosing-bugs`, `code-review`, `research`) map to `delegate`; every other
   skill runs in the Lead conversation. The guidance carries an index of skill
   files because many of Matt's skills are hidden from Pi's skill list
   (`disable-model-invocation`).
2. **A worker is a Pi like the Lead.** Same package skills, same global skills
   and prompts, the repository's `AGENTS.md`, and, when the Lead trusts the
   project, the repository's `.agents/skills`, `.pi/skills`, `.pi/prompts` and
   `.pi/APPEND_SYSTEM.md`, snapshotted right after cloning. Workers load only
   the PI Lead worker extension and Herdr's own Pi integration, not project or
   global extensions.
3. **Herdr shows and carries messages; files decide.** Workers run with
   `HERDR_AGENT=pi` and, when installed (`herdr integration install pi`),
   Herdr's Pi integration, so Herdr shows their working/idle state. Results
   are the worker's `finish` file (numbered, so a worker can finish again);
   `run.sh` records Pi's exit status so a worker that dies without `finish` is
   reported at once. The Lead talks to a worker with `herdr agent prompt`
   (messages prefixed `[PI Lead]`), falling back to `herdr pane run`.
4. **Delegation does not block the Lead.** `delegate` returns as soon as the
   worker is queued; each result arrives as a message that wakes the Lead. A
   worker that stops on a question stays open and watched; the `worker` tool
   lists, messages or stops workers.
5. **Only the Lead's pane outlives the Lead.** A worker tab closes at once when
   done, after `waitingTimeoutMinutes` (default 120) without an answer when
   waiting, and at the latest when the Lead session ends. `keepFailedWorkers`
   keeps a failed worker's tab only while the Lead runs, and its directory
   after. Each task dir holds `tab.json` (tab and pane ids, Lead pid); on start
   a Lead closes the tabs of Leads whose process is gone and removes their
   dirs. Worker panes carry display-only `herdr pane report-metadata` and an
   `herdr agent rename` name, best-effort; never `report-agent`, which would
   take lifecycle authority from Herdr's Pi integration.
