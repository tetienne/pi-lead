---
status: superseded
---

> Superseded by [ADR 0005](0005-lead-is-a-tool-driven-conversation.md) (2026-09-22).

# Own worker lifecycle outside Herdr's presentation state

Herdr owns terminal presentation, while a trusted host controller owns task identity, worker VMs, result collection and cleanup. Herdr's idle/done observations and waits do not establish task completion, and its official Pi restore path launches host Pi; guest sessions therefore use custom reporting and separate task records. This adds a small lifecycle owner but avoids exposing Herdr control authority to workers or confusing restored tabs with resumed work. Failed workers stop while diagnostics remain, and interrupted work resumes only after human confirmation, as agreed in the interview. See the [Herdr contracts](../research/herdr-contracts.md) and [specification](../../.scratch/pi-lead/spec.md).
