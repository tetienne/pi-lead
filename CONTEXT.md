# PI Lead

PI Lead coordinates engineering work requested in natural language, with visible workers and verifiable results across consuming projects.

## Language

**Lead**:
The user's persistent point of interaction and the coordinator of an engineering task.
_Avoid_: Worker, background agent

**Worker**:
An agent assigned a bounded part of a task, with its own visible working session and its own branch and worktree of the repository.
_Avoid_: Lead

**Consuming project**:
A project in which the user activates PI Lead to perform engineering work; distinct from the PI Lead package itself.
_Avoid_: PI Lead repository

**Task**:
A user-requested engineering outcome, which may require several workers and validation steps.
_Avoid_: Turn, ticket

**Ticket**:
A self-contained, verifiable slice of planned work, with explicit Blocked-by dependencies on other tickets.
_Avoid_: Task, conversation turn

**Sub-agent**:
A one-shot agent that a skill starts, from the Lead or a worker, for an isolated step, and whose report returns to the agent that started it.
_Avoid_: Worker, subtask

**Human gate**:
A point at which work requires an explicit human decision or authorization before it can proceed.
_Avoid_: Model approval

**Policy**:
The deterministic rules that turn model judgments and host evidence into actions, which no model answer can override.
_Avoid_: Prompt, model judgment

**DONE**:
A worker outcome whose required checks passed and whose results were collected.
_Avoid_: Agent idle, process exited

**BLOCKED**:
A worker outcome that requires human intervention or has reached an applicable retry limit, with diagnostic evidence preserved.
_Avoid_: DONE, success
