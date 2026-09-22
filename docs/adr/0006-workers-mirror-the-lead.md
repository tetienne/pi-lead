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
   `.pi/APPEND_SYSTEM.md` (read from the worker's clone). Code is the
   exception: project and global extensions would run on the host, outside the
   VM, so workers load only the PI Lead worker extension and Herdr's own Pi
   integration.
3. **Herdr shows, files decide.** Workers run with `HERDR_AGENT=pi` and, when
   installed, Herdr's Pi integration, so Herdr shows their working/idle state.
   Completion is still the worker's `finish` result file; `run.sh` records Pi's
   exit status so a worker that dies without `finish` is reported at once.
4. **Toolchains: mise inside the guest, cached per project.** The host's mise
   cache holds host binaries (macOS on a Mac) that a Linux guest cannot run.
   The first worker of a project (or of a changed mise configuration) runs
   `mise install` in a warm-up VM that writes to a per-project cache; workers
   mount it read-only at `/opt/mise`, so later starts are instant and a worker
   cannot poison the next one's tools. The default image is Debian (glibc) with
   git and mise, built from `sandbox/Dockerfile`; Alpine remains an option.
