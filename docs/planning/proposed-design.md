# Design for interview confirmation

Interview proposal, now superseded by the [approved specification](../../.scratch/pi-lead/spec.md). Consult the specification for the accepted design. Ticket granularity remains the next review checkpoint; technical integration claims still require later runtime validation.

## Smallest useful composition

Distribute one pinned Pi package, activated per consuming project. Its thin Lead extension uses native Pi intake, session, and model mechanisms. Keep policy and lifecycle logic independent of Pi and Herdr so their behavior can be tested without launching either.

Use a trusted host launcher to own worker VMs, task identity, artifacts, and Herdr tabs. Start with local process ownership, not a permanent background service. Persist sufficient host-owned task/resource records to reconcile interrupted work; after a crash, show the recovered state and await confirmation before resuming work. Storage format remains an implementation choice until lifecycle contracts are settled.

Each worker runs Pi and its child processes inside Gondolin. Use native terminal attachment and Herdr's host-side status mechanisms. Keep credentials, host control sockets, shared Git administration, and writable global caches outside guests. Project-defined mise tasks and validations run inside isolation. Native primitives remain the first choice for toolchains, transport, and artifact transfer.

Prove the first real worker with ChatGPT Pro, retaining host ownership of real tokens; the user reports OpenCode Go currently exhausted. Add OpenCode Go when its included quota is available. Both providers remain required. Use TypeSafe's official SDK with OpenRouter's native Jev route if its documented compatibility validates; no additional provider framework. Jev has a $1/day ceiling, not a spending target. Disable optional Pi cache warming initially; include compaction and transport retries in usage controls.

## Workflow and result ownership

The user stays in the Lead tab. Workers receive bounded assignments and appear in named tabs without stealing focus. The Lead uses Matt workflows according to their contracts rather than converting every skill into an orchestration state.

Host policy constrains Jev's candidates before inference and validates the response afterward. Inference never authorizes privileged operations or declares DONE. Unclear intake returns to clarification; resource uncertainty uses only an adequate, explicitly allowed fallback.

Work originates from a named committed base. If the task needs the user's uncommitted changes, inclusion is an explicit decision. Workers return changes for validation and integration onto a task branch without altering the user's active checkout. Validated task branches may be pushed automatically to the configured consuming-project remote. Main-branch merges, PR creation, deployment and privileged operations retain their human gates.

Collect results, verify required checks and independent review against the final changes, and prove worker teardown before closing successful tabs and reporting DONE. A model's success claim, a quiet terminal, an idle event, and a process exit are each insufficient alone. Failed/BLOCKED work preserves diagnostics and a visible tab while stopping autonomous execution. Cleanup failure prevents DONE.

Measure image preparation and warm worker startup separately from the first slice. Start with the accepted two-worker limit, read-only cache seeds and private writable caches. Avoid a cross-agent cache-promotion system until measured performance justifies it.

## Proposed test seams to confirm before to-spec

1. **Task lifecycle:** request through collected result, validation/review, cleanup, interruption and recovery. Exercise public behavior with controlled runtime substitutes, then the same scenarios against real Pi/Herdr/Gondolin integration.
2. **Policy decisions:** allowed actions/resources from trusted state, authorization and a supplied judgment. Test malformed, stale, ambiguous, over-budget and out-of-catalog inputs without paid inference.

Real integration acceptance must additionally cover guest filesystem/network/credential confinement, termination and orphan handling, model streaming/authentication, focus-preserving visibility and all supported host targets. These tests prove behavior that fake adapters cannot.

## Review checkpoint

Push authorization and Jev's $1/day ceiling were approved in Q14–15. Q16 corrected provider order to ChatGPT Pro first. The specification will present the complete design and test seams for approval before tickets or implementation. No paid requests have been made.
