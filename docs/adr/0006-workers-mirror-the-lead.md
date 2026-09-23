---
status: accepted
amends: 0005
---

# Workers mirror the Lead; Matt's router drives the Lead; toolchains come from mise

Decided 2026-09-22.

1. **ask-matt is the Lead's router.** For anything that is not a plain
   question, the Lead reads Matt Pocock's `ask-matt` skill and follows the
   flow it names, instead of PI Lead keeping its own list of flows. Execution
   skills (`implement`, `prototype`, `diagnosing-bugs`, `code-review`,
   `research`) map to `delegate`; every other skill runs in the Lead
   conversation. The guidance carries an index of skill files because many of
   Matt's skills are hidden from Pi's skill list (`disable-model-invocation`).
2. **A worker is a Pi like the Lead.** Same package skills, same global skills
   and prompts, the repository's `AGENTS.md`, and, when the Lead trusts the
   project, the repository's `.agents/skills`, `.pi/skills`, `.pi/prompts` and
   `.pi/APPEND_SYSTEM.md`. These are copied out of the clone right after
   cloning, before any guest runs (regular files only, no symlinks), and Pi's
   cwd and the tab's shell sit outside the clone: host processes never read
   guest-writable files or run git in the clone. Code is the
   exception: project and global extensions would run on the host, outside the
   VM, so workers load only the PI Lead worker extension and Herdr's own Pi
   integration.
3. **Herdr shows and carries messages; files decide.** Workers run with
   `HERDR_AGENT=pi` and, when installed (`herdr integration install pi`),
   Herdr's Pi integration, so Herdr shows their working/idle state. Results
   are the worker's `finish` file (numbered, so a worker can finish again);
   `run.sh` records Pi's exit status so a worker that dies without `finish` is
   reported at once. The Lead talks to a worker with `herdr agent prompt`
   (messages prefixed `[PI Lead]`), falling back to `herdr pane run`.
4. **Delegation does not block the Lead.** `delegate` returns as soon as the
   worker is queued; each result arrives as a message that wakes the Lead, so
   the user can keep asking questions while workers run. A worker that stops
   on a question stays open and watched; the `worker` tool lists, messages or
   stops workers, and the worker's next `finish` is reported whether the
   answer came from the Lead or from the user typing in its tab.
5. **Toolchains: mise inside the guest, cached per project.** The host's mise
   cache holds host binaries (macOS on a Mac) that a Linux guest cannot run.
   The first worker of a project (or of a changed mise configuration) runs
   `mise install` in a warm-up VM that writes to a per-project cache; workers
   mount it read-only at `/opt/mise`, so later starts are instant and a worker
   cannot poison the next one's tools. The default image is Debian (glibc) with
   git and mise, built from `sandbox/Dockerfile`; Alpine remains an option.
