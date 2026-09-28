# 05: Workers are plain Pi

**What to build:** A worker Pi loads the user's own global extensions (and project extensions when the project is trusted), including Herdr's Pi integration, without PI Lead naming them; only the worker extension is added. PI Lead's Lead extension stays inert in any Pi that PI Lead started, detected from an environment marker PI Lead sets at launch, so a worker never becomes a second Lead. See [spec](../spec.md), "Workers are plain Pi".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Resolution:** DONE

- [x] The worker command has no `--no-extensions` and does not name Herdr's extension (test).
- [x] The worker's launch script sets the PI Lead marker (test).
- [x] With the marker set, the Lead extension registers no tools, commands, prompt guidance or handlers (test).
- [x] Without the marker, the Lead registers as today (test).
- [x] README "worker" section describes workers as plain Pi with the user's extensions.
- [x] `npm test` and `npm run typecheck` pass.
