---
status: superseded
---

> Superseded by [ADR 0005](0005-lead-is-a-tool-driven-conversation.md) (2026-09-22).

# Separate durable task ownership from native conversations

Retain Pi's native conversation storage, but keep a small host-owned durable task record for resource IDs, intended actions, results, approvals and verification evidence. Conversation branching and nondurable Herdr metadata cannot be the authoritative ownership log for multiple processes and VMs. Begin with atomic per-task records and a single controller writer per consuming project rather than a database or workflow engine; on recovery reconcile real resources and require human confirmation before resuming. This trades a small amount of explicit persistence for recovery that does not replay uncertain side effects. See [Pi contracts](../research/pi-contracts.md), [Herdr contracts](../research/herdr-contracts.md) and the [specification](../../.scratch/pi-lead/spec.md).
