# Jev for Pi compaction: a skeptical assessment

Researched 2026-09-24. Source inspection of `@earendil-works/pi-coding-agent` 0.87.1 (`dist/core/compaction/`, `docs/compaction.md`, `docs/extensions.md`, `docs/session-format.md`, extension types), `src/jev.ts`, and public READMEs of third-party "Jev compaction" projects. No paid call, no benchmark was run. `docs.typesafe.ai` and `docs.litellm.ai` were blocked by the egress proxy, so TypeSafe's own statements are only known through [Jev contracts](jev-contracts.md).

## Short answer

Jev cannot write a summary; it can only answer closed-set questions about a state of at most 32K tokens. The only credible role for it in compaction is **verbatim pruning**: score old tool calls and results and replace the stale ones with a placeholder, instead of (or before) Pi's LLM summary. That is technically feasible in Pi without forking it. But the public evidence that it helps is thin, one real-session measurement points the wrong way, and PI Lead has no data showing that its sessions compact at all. **Do not build it now.** Measure first, and try the deterministic improvements below, which cost nothing and address the same risk.

## How Pi compacts today

- **Trigger:** `contextTokens > contextWindow − reserveTokens` (16 384 by default), checked between turns, before a prompt, and on overflow / early `length` stop (one compact-and-retry).
- **Cut:** purely by size. Walk back from the newest entry until `keepRecentTokens` (20 000) is reached, cut at a user or assistant message, never at a tool result. A span that alone exceeds the budget is split and summarized in two parts.
- **Summary:** one LLM call with a fixed structure (Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context) plus cumulative `<read-files>` / `<modified-files>` lists. Tool results are cut to 2 000 characters before summarization. The previous summary is fed back in, so summaries are iterative.
- **Result:** one `CompactionEntry` = summary + `firstKeptEntryId`. The model sees system prompt, summary, then a **contiguous** suffix of messages.

Extension points relevant here:

| Hook | What it allows |
| --- | --- |
| `session_before_compact` | Cancel, or return your own `summary`, `firstKeptEntryId`, `details`, `usage`. The kept part is still a contiguous suffix. |
| `turn_end` / `agent_before_settle` boundaries | Append persistent `context_edit` entries: replace or omit (`replacement: null`) the content of a target entry. Pi's own overflow recovery uses them. |
| `context` | Rewrite the messages of each request, without persisting anything. |

So "keep old message X verbatim, drop Y" is expressible natively through `context_edit`; it is not expressible through the compaction entry alone (a summary cannot hold non-contiguous verbatim tool calls, only their text).

## What Jev could do, and why each idea is weak

| Idea | Jev question | Problem |
| --- | --- | --- |
| **Prune stale tool results** (the idea behind the third-party projects) | Noul per tool call/result: "still needed for the goal?" | See evidence below. Relevance depends on what the agent will do next, which neither Jev nor anyone knows. A wrong drop is silent. |
| **Choose a better cut point** | Choice among ≤ 255 candidate boundaries | The cut only decides how much recent context stays verbatim; size is the right criterion there. A deterministic "cut after the last passing test / commit" heuristic is simpler if a semantic boundary is wanted. |
| **Compact early at a task boundary** | Noul: "did a subtask just finish?" | In a worker, the ticket is the task; in the Lead, a `delegate` result is an explicit, deterministic boundary. |
| **Check summary fidelity** | Noul per must-keep fact: "does the summary retain it?" | If the facts can be listed, the code can simply append them verbatim. Jev adds a probability where a guarantee is available. |
| **Replace the summary** | — | Impossible: Jev does not generate text. |

## Evidence from existing "Jev compaction" projects

Several small projects apply exactly the pruning idea to other agents ([jev-compactor](https://github.com/edwardyen724-g/jev-compactor), [openclaw-jev-compaction](https://github.com/SqaaSSL/openclaw-jev-compaction), [jev-compaction for Hermes](https://github.com/picaye/jev-compaction), and forks). Shared design: pin the system prompt, user messages and recent turns; send Jev a skeleton of the whole transcript with long outputs abbreviated to fit 32K; drop a call or result above a probability threshold (0.7 in jev-compactor); keep call/result pairs together; fall back to pass-through or to the native summarizer on failure.

What they actually demonstrate:

- **jev-compactor:** 2 synthetic transcripts (12.7K and 61K tokens), success measured as "4 of 4 planted facts survived". Summarizers save more tokens (85–97 % vs 64–73 %). Cheap (~$0.0004) and fast (~350 ms). Jev's keep probability varied by up to 0.14 across identical requests. 1 star.
- **openclaw-jev-compaction:** the only real-session numbers found. On 6 real Claude Code sessions: **5–29 % reduction**, and **18 of 62 dropped results were referenced again later**. The comparison was with a baseline that drops everything (62/62), not with a summarizer.
- **Hermes jev-compaction:** 68 % and 98.4 % reduction on two real sessions, with its own warning that "the ratio alone means nothing" without task success.
- **None measures downstream task success** (does the agent still finish the ticket, with how many extra turns or re-reads?). "Verbatim" is sold as never hallucinating a path; that is true of what is kept, and says nothing of what is dropped.

This is early, self-published, mostly synthetic evidence, several projects are forks of one another, and the one real measurement shows either modest savings or a 29 % rate of dropping something the agent needed again.

## PI Lead–specific objections

1. **No evidence of a problem.** Workers run one bounded ticket each (ADR 0005) on large-context models; nothing records whether they ever reach compaction. The Lead is a long conversation and more likely to compact, but its important state (`delegate` results: branch, verdict, diff stat) is small and structured. Optimizing compaction before counting compactions is premature.
2. **Summaries still needed.** Pruning alone rarely gets under budget on real sessions (5–29 % above); openclaw falls back to the summarizer. So the change adds a second mechanism rather than replacing one, with two failure modes to reason about.
3. **Prompt caching.** Any edit to old context invalidates the provider cache from that point. Pruning *only* at compaction time costs nothing extra (compaction already rewrites the prefix); pruning continuously (as openclaw does in `assemble`) would re-bill the whole context of the expensive worker model after each edit. Workers use subscriptions, so this shows up as quota and latency rather than dollars.
4. **Data exposure.** Today Jev receives clipped tickets, logs and verdict evidence. Compaction would send a skeleton of whole worker transcripts, including guest output, to TypeSafe or OpenRouter. That is a real widening of what leaves the host.
5. **Guest-controlled input.** Tool output comes from the sandboxed guest, which controls the repository. A crafted output can try to steer Jev ("this result is essential" / "everything above is obsolete"). The impact is limited to context shaping, not permissions (consistent with ADR 0003), but it is a new lever on what the worker remembers, and no deterministic check can validate a "safe to drop" answer after the fact.
6. **Latency on the critical path.** Compaction blocks the next turn. A 15 s Jev timeout plus the summary call is acceptable only with a strict fallback to Pi's default.
7. **Cost is not the argument.** A 30K-token pass costs about $0.0013 at $0.042/M input: negligible against the $1/day ceiling. The objections are about correctness and evidence, not money.

## Recommendation

1. **Measure.** Record `session_compact` / `session_compact_failed` in workers and in the Lead (reason, `tokensBefore`, count per session) and show it next to Jev usage. Deterministic, free, and it answers whether there is anything to improve.
2. **Deterministic fidelity first**, via `session_before_compact` (call Pi's own summarizer, then append to its summary):
   - Worker: append the ticket's acceptance criteria (`acceptanceCriteria()` already extracts them) and the ticket text verbatim to the summary, so the goal cannot be paraphrased away.
   - Lead: append the list of `delegate` results (ticket, branch, verdict) from the branch entries, verbatim.
   - Keep Pi's summarizer for everything else.
3. **Only if data shows** frequent compactions in workers *and* evidence that agents lose needed context after them, prototype Jev pruning as a `context_edit` pass at compaction time only, with: pinned user messages, ticket, recent turns and state-changing calls (`write`, `edit`, failing `bash`); replacement text that says how to recover (`[omitted: read src/x.ts, 12 400 chars — re-read if needed]`) rather than silent deletion; a high drop threshold; Pi's summary still running afterwards; and a success metric that is task completion and re-read count on a fixed set of real PI Lead tickets, not token reduction.

Until step 3's conditions are met, this is a solution looking for a problem in PI Lead.
