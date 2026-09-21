# Matt workflow contracts

Reviewed the installed skill entrypoints named in bootstrap section 4. These are workflow contracts, not a proposed orchestration state machine. Sources below refer to the project-local skills recorded in `skills-lock.json`.

| Skill | Contract relevant to PI Lead |
| --- | --- |
| [ask-matt](../../.agents/skills/ask-matt/SKILL.md) | Routes engineering work; multi-session builds use interview, spec, tickets, then fresh implementation contexts. |
| [grill-with-docs](../../.agents/skills/grill-with-docs/SKILL.md) | Combines grilling with domain-modeling. |
| [grilling](../../.agents/skills/grilling/SKILL.md) | Ask independent unresolved decisions in rounds; research facts; obtain shared understanding before acting on the design. |
| [research](../../.agents/skills/research/SKILL.md) | Background research produces one cited Markdown note based on primary sources. |
| [diagnosing-bugs](../../.agents/skills/diagnosing-bugs/SKILL.md) | Establish an executed, symptom-specific failing feedback loop before hypotheses; minimize, diagnose, fix, and verify. |
| [domain-modeling](../../.agents/skills/domain-modeling/SKILL.md) | Maintain a domain glossary and sparse ADRs as terms and consequential trade-offs settle. |
| [codebase-design](../../.agents/skills/codebase-design/SKILL.md) | Shared vocabulary and principles for deep modules and meaningful test seams; a cross-cutting discipline. |
| [prototype](../../.agents/skills/prototype/SKILL.md) | Throwaway runnable evidence answers a specific logic or UI question; preserve findings and source. No prototype is authorized by this planning record. |
| [wayfinder](../../.agents/skills/wayfinder/SKILL.md) | Decision tickets map work too uncertain for a single interview; it hands decisions to spec rather than directly building. |
| [triage](../../.agents/skills/triage/SKILL.md) | Verify incoming requests and produce agent-ready briefs; already-ready generated tickets do not require retriage. |
| [to-spec](../../.agents/skills/to-spec/SKILL.md) | Synthesize settled context without another discovery interview; agree test seams, then publish the specification. |
| [to-tickets](../../.agents/skills/to-tickets/SKILL.md) | Draft complete vertical slices with blocking edges; obtain granularity approval before publishing one file per ticket. |
| [implement](../../.agents/skills/implement/SKILL.md) | Build the specified work using TDD where possible at agreed seams, check it, run code-review, then commit. |
| [tdd](../../.agents/skills/tdd/SKILL.md) | One behavior, failing test, and minimal passing implementation per cycle at agreed public seams. |
| [code-review](../../.agents/skills/code-review/SKILL.md) | Pin comparison and spec source; independent parallel Standards and Spec reviews remain separately reported. |
| [improve-codebase-architecture](../../.agents/skills/improve-codebase-architecture/SKILL.md) | Survey real friction, present candidates, and interview the user about the chosen opportunity. |
| [resolving-merge-conflicts](../../.agents/skills/resolving-merge-conflicts/SKILL.md) | Resolve by source intent, run validation, and finish the merge/rebase; execution remains subject to project authorization. |
| [handoff](../../.agents/skills/handoff/SKILL.md) | Write a portable, redacted handoff in the OS temporary directory; reference existing artifacts instead of duplicating them. |
| [wizard](../../.agents/skills/wizard/SKILL.md) | Produce a scoped procedure only for steps requiring a human; do agent-runnable work directly. |
| [writing-for-agents](../../.agents/skills/writing-for-agents/SKILL.md) | Keep agent-facing instructions focused, with explicit completion criteria and conditional pointers to reference material. |

## Implications

- A skill is not necessarily a state. Domain-modeling, codebase-design, writing-for-agents, and TDD guide work across phases.
- Human decisions and external actions remain governed by user authorization and deterministic policy; skill instructions do not grant worker permissions.
- The bootstrap requires specification approval before implementation. A skill's default `ready-for-agent` status must not bypass that gate.
- Matt setup uses the agreed local tracker and canonical triage vocabulary, documented in AGENTS.md and docs/agents/ after user approval of the concrete draft.
- The bootstrap requests goals in CONTEXT.md, whereas the domain-modeling skill normally limits it to a glossary. CONTEXT.md includes the brief project objective and domain language; detailed requirements remain in the bootstrap and planning record until spec synthesis.
