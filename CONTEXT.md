# PI Lead

PI Lead coordinates engineering work requested in natural language, with visible workers and verifiable results across consuming projects.

## Language

**Lead**:
The user's persistent point of interaction and the coordinator of an engineering task.
_Avoid_: Worker, background agent

**Worker**:
An agent assigned a bounded part of a task, with its own visible working session and its own clone of the repository.
_Avoid_: Lead

**Consuming project**:
A project in which the user activates PI Lead to perform engineering work; distinct from the PI Lead package itself.
_Avoid_: PI Lead repository

**Task**:
A user-requested engineering outcome, which may require several workers and validation steps.
_Avoid_: Turn, ticket

**Ticket**:
A self-contained, verifiable slice of planned work with explicit dependencies on other tickets.
_Avoid_: Task, conversation turn

**Human gate**:
A point at which work requires an explicit human decision or authorization before it can proceed.
_Avoid_: Model approval

**Policy**:
The deterministic rules constraining which actions and resources the Lead and workers may use.
_Avoid_: Prompt, model judgment

**DONE**:
A task outcome whose required validations passed, results were collected, and temporary resources were cleaned up.
_Avoid_: Agent idle, process exited

**BLOCKED**:
A task outcome that requires human intervention or has reached an applicable retry limit, with diagnostic evidence preserved.
_Avoid_: DONE, success
