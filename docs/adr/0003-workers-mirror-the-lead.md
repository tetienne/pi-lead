---
status: accepted
---

# Workers are plain Pi, like the Lead; Matt's router drives the Lead

For anything that is not a plain question, the Lead reads Matt Pocock's
`ask-matt` skill and follows the flow it names, reading each skill's file from
an index in its guidance (many of Matt's skills are hidden from Pi's skill
list by `disable-model-invocation`). PI Lead adapts to Matt's skills through
its own guidance and never edits the vendored skills.

A worker is the same Pi as the Lead: the user's own extensions, the same
skills, prompts and `AGENTS.md`, plus only PI Lead's worker extension. It
trusts its worktree exactly when the Lead trusts the project (passed per
process, never saved), so a trusted project's worker loads that project's
extensions and resources by Pi's own discovery, and an untrusted one loads
none. Every Pi that PI Lead starts carries a role marker, under which the
Lead extension stays inert, so a worker or sub-agent never becomes a second
Lead. We chose this over a curated worker (no extensions, copied project
resources) because a worker should be able to do what the user's Lead can,
and Pi has no per-run switch to exclude one extension other than such a
marker.

Herdr shows workers and carries messages; files decide. A worker waiting on
the user's answer waits until answered or stopped. Only the Lead's pane
outlives the Lead session: a worker's worktree workspace is removed when its
work ends (a green PR's when it merges), at the latest when the session ends,
and its branch always stays.
