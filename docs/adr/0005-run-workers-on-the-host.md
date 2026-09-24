---
status: accepted
---

# Run workers on the host, in their own git clone

A worker's Pi runs on the host with its stock tools and its cwd set to a
throw-away local clone of the repository; the Lead brings work back with
`git fetch` from that clone. There is no VM, container image, sidecar service,
guest toolchain cache or egress allowlist: the isolation machinery cost more
to keep working than it protected, and it drove most of the codebase.

The trade-off is deliberate: a worker has the same network and filesystem
access as the user running the Lead. Isolation between workers and from the
user's checkout comes only from separate clones and branches.
