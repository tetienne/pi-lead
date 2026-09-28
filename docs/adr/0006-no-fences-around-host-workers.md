---
status: accepted
---

# No fences around host workers

While workers ran sandboxed, several mechanisms fenced them in: the Lead asked
the user before any tool call that could execute or write on the host after a
worker report (the Lead guard), a scout fixed the files an implementer could
touch and capped any other change to `partial` (the scope fence), and the host
check chased evasions of its sensitive-path list (symlinked parents, case
variants, `package.json` script diffs). A prompt-injected worker could only do
harm through those paths.

Since workers run on the host with the user's own access (ADR 0005), an
injected worker can act directly: it needs neither to steer the Lead nor to
hide a change from a path check. The fences only guarded the longer route,
and cost a confirmation after every report, a scope widening to approve and a
second worker per ticket. They are removed, and old `leadGuard` keys in a
config file are ignored.

What stays is for the human's review, not a boundary: worker text reaches the
Lead marked `<worker-report untrusted>`, and the Lead reports it without
following instructions in it; the report card shows every line the worker
wrote; the host check still names the sensitive paths a branch touches, as a
hint. If workers are sandboxed again (ADR 0007's limit), revisit this.
