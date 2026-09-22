> Amended by [ADR 0005](0005-lead-is-a-tool-driven-conversation.md) (2026-09-22): the VM boundary now covers every model-driven tool call, while the trusted Pi agent loop runs on the host.

# Isolate the first real autonomous worker

Accepted during the bootstrap interview. The first worker executing real engineering work must run inside an OS/VM security boundary, even though the bootstrap's suggested slices originally deferred isolation to MVP 2. This brings integration cost forward so the first usable lifecycle does not depend on unrestricted host execution; a harmless fixture can precede it. Gondolin remains a candidate pending contract research and later permission/escape validation, rather than an already-proven security boundary.
