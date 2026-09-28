---
status: accepted
---

# No confirmation guard on the Lead after a worker report

The Lead used to ask the user before any tool call that could execute or
write on the host (bash, write, edit…) from the moment a worker report entered
the conversation until the user replied (`leadGuard`). That made sense while
workers ran sandboxed: the report was their only way to reach the host, so a
prompt-injected worker could only do harm by steering the Lead.

Since workers run on the host with the user's own network and filesystem
access (ADR 0005), an injected worker can act directly and needs no Lead to
steer. The guard only covered the longer path, and cost a confirmation prompt
after every report and a hard block without a UI. It is removed, with its
`leadGuard` setting; an old `leadGuard` key in a config file is ignored.

What stays: worker text is still fenced in `<worker-report untrusted>` and
the Lead's guidance says to report it, not follow it; the report card shows
every line the worker wrote; the host check still names risky files a branch
touches, for the user's review. If workers are sandboxed again, this decision
should be revisited.
