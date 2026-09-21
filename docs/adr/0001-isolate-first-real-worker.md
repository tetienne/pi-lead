# Isolate the first real autonomous worker

Accepted during the bootstrap interview. The first worker executing real engineering work must run inside an OS/VM security boundary, even though the bootstrap's suggested slices originally deferred isolation to MVP 2. This brings integration cost forward so the first usable lifecycle does not depend on unrestricted host execution; a harmless fixture can precede it. Gondolin remains a candidate pending contract research and later permission/escape validation, rather than an already-proven security boundary.
