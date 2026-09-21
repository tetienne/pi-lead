# Jev native contracts and bounded routing

Researched 2026-09-21. Documentation/source inspection only: no installation, credentials, inference requests, or model-quality benchmark. Recommendations below are design proposals, not implementation or spending authorization.

## Official reference and version

The official skill is `typesafe-ai` in TypeSafe's `typesafe-ai/skills` repository, not a community `jev` executable or MCP wrapper. Its complete 131-line rendered content was read. GitHub's commit API identified main as `65a39f393687675ce170e6094757de20370365b9`, release commit `v0.5.7`, dated 2026-09-12. The skill has MIT licensing and no separate version field. [Pinned skill](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md), [commit](https://github.com/typesafe-ai/skills/commit/65a39f393687675ce170e6094757de20370365b9).

The skill delegates API truth to live documentation. Its relevant requirements: keep exact rules and execution in code; give questions sufficient named state; include no-match outcomes; batch independent judgments; consume only applicable branches; recheck state freshness; calibrate thresholds on target examples. It explicitly separates typed interfaces from semantic truth and probability concentration from permission. [Official skill](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md).

The docs index and Markdown variants failed through the web reader; normal documentation pages succeeded. This does not imply service unavailability.

## Native judgment semantics

| Primitive | Contract | PI Lead application |
| --- | --- | --- |
| Choice | One option from a named criteria map; highest-probability choice plus distribution and confidence | Intent or categorical resource requirement |
| Noul | Probability of yes, from 0 to 1; optional true/false descriptions; no separate confidence | Independent semantic condition |
| Score | Probability-weighted position on an ordered rubric, potentially fractional; distribution, confidence and legend | Difficulty along one defined dimension |

Native requests contain `model`, `state` (string/object/array), and named `questions`. Questions have `type`, `instructions`, and type-specific `criteria`; IDs correlate answers but do not reach inference. Choice permits up to 255 options; Score requires at least two levels and accepts up to ten. Responses contain `model`, named `answers`, and token `usage`. TypeSafe's own endpoint is `POST https://api.typesafe.ai/v1/systemone`. [HTTP reference](https://docs.typesafe.ai/api).

Confidence measures how concentrated the probability distribution is, not whether the application is correct. Noul near 0.5 means uncertainty between yes/no, not medium severity. Thresholds in examples are illustrative; determine thresholds using representative routing examples and consequences. [Confidence](https://docs.typesafe.ai/confidence).

TypeSafe already documents intent plus complexity routing to deterministic handlers, specialists, or a human. Its closed-set function-calling cookbook models handler and enum arguments using Choices; it does not require inventing another natural-language dispatcher framework. [Intent routing](https://docs.typesafe.ai/patterns/intent-routing), [closed-set dispatch](https://docs.typesafe.ai/cookbooks/function_calling).

## OpenRouter availability and integration choice

OpenRouter lists Jev 1.13 with 32K context, currently $0.042 per million input tokens and $0 output. Zero-priced output does **not** make inference free. Public listing establishes advertised availability, not this user's account access or end-to-end reliability. [Provider/model listing](https://openrouter.ai/typesafe).

The live OpenAPI declares **both** `/api/alpha/decisions` at origin `https://openrouter.ai` and `/systemone` under the global `/api/v1` base. The latter explicitly supports TypeSafe SDKs and maps bare Jev IDs into the TypeSafe namespace. This is stronger evidence than older advice claiming only the alpha route exists. Both use DecisionsRequest/Response. Optional gateway fields include provider preferences and session/trace/user metadata. Choice/Score confidence and probabilities are optional in the gateway schema; `choice` is a string, not a request-specific enum. Usage cost is optional. These differences require local validation. [OpenRouter OpenAPI](https://openrouter.ai/openapi.json).

The official JavaScript SDK is `@typesafe-ai/sdk`, requiring Node 20+. The docs link source at **v0.6.0**. No package has been installed or selected yet. [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).

Source inspection confirms configurable `baseURL`, explicit API key/model, timeout, cancellation, retry settings and fetch injection. The client appends `/v1/systemone`; therefore `baseURL: https://openrouter.ai/api` yields the documented native OpenRouter route. This URL composition is a source-based inference, not a live-call test. The client casts parsed response data to its generic return type without runtime answer validation. Avoid debug logging of sensitive state: the client logs request/response bodies at debug level. [SDK v0.6.0 client](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts).

**Recommendation:** use the official TypeSafe SDK against OpenRouter's native System One route, subject to an eventual authorized smoke test and gateway metadata/accounting check. Plain HTTP is a small alternative if SDK compatibility proves insufficient. Neither a community CLI nor MCP bridge is necessary. Keep one narrow boundary translating validated judgments into PI Lead decisions; do not create a general provider framework or reproduce the native question types.

## Deterministic enforcement boundary

The following is a PI Lead proposal derived from the bootstrap constraints, not a Jev security guarantee:

1. Policy produces permitted candidates from current configuration, installed model capabilities, user authorization, and remaining budget **before** querying Jev.
2. Intake Choice starts with the brief's CHAT, IMPLEMENT, IDEATE, DEBUG, REVIEW, RESEARCH, TRIAGE, WAYFIND, OPERATE catalogue plus an explicit no-match/uncertain path. Confirm overlapping labels with examples before freezing the schema. Classification chooses the next workflow entry, not every later workflow stage.
3. At spawn, ask narrowly defined difficulty/context judgments over the actual bounded task. Exact context size, subscription eligibility, model availability, concurrency and spend limits are computed in code. A fixed table maps validated categories to permitted model/reasoning pairs.
4. Validate response shape, matching question IDs/types, finite numeric ranges, required evidence and membership in the exact submitted candidates. Never turn an arbitrary returned string into a model name, shell command, skill path or permission.
5. Recheck policy and state version before acting. A previously permitted candidate may have become unavailable or exhausted.
6. Jev never controls secrets, sandboxing, privileged operations, review bypass, approvals or DONE. OPERATE classification cannot authorize operation execution.

Native typed Choice reduces interface ambiguity; it does not replace this boundary. Runtime validation remains necessary even with TypeScript inference, especially because the gateway permits less evidence than TypeSafe's direct response documentation promises.

## Fallback, retry and cost

The official JS SDK defaults to two retries, a ten-second timeout per attempt, exponential backoff starting at 500 ms (5 s cap), jitter, and Retry-After support up to 60 s. It retries 408, 429, 5xx, connection failures and timeouts. These are transport retries, independent of the project's two review/fix cycles. [SDK retry source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts).

Proposed behavior: explicit workflow commands bypass semantic routing when valid; ambiguous/low-confidence intake returns to Lead clarification without spawning. Resource uncertainty uses a preapproved adequate default, if one exists, otherwise blocks. Unavailable service, malformed/missing evidence and exhausted budget must not silently select a paid alternative. Set one bounded transport policy and total deadline; avoid multiplying SDK retries with an outer retry loop. Do not retry semantic ambiguity hoping for a convenient answer. Canceled/timeout requests may already have consumed provider work, so a timeout is not proof of zero cost.

OpenRouter supplies API-key USD limits, optional daily/weekly/monthly resets, expiration, and BYOK inclusion settings. Its current-key endpoint reports usage and remaining limit. Use a dedicated bounded inference key; key-management credentials are unnecessary in workers or the normal router. [Key limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys), [current-key accounting](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).

OpenRouter guardrails additionally document budget rejection, model/provider restrictions and privacy controls. Account availability and Decisions-route enforcement need verification before treating these as the sole control. Local request caps and a provider-side cap complement one another; documentation alone is not proof of an exact concurrency-safe financial ceiling. [Guardrails](https://openrouter.ai/docs/guides/features/guardrails/overview).

## Remaining decisions and evidence

- User approved a $1/day OpenRouter ceiling for Jev in Q15, while explicitly preferring lower actual spend. Treat it as a maximum, never a spend target. No paid calls have been made; provider-side key configuration and enforcement remain unverified.
- Before implementation locks the transport: re-read the native OpenRouter SDK guide (fetch timed out), confirm package version and native route compatibility, optional metadata/cost retention, and a synthetic request after credentials and budget are authorized.
- Before automatic routing: evaluate representative intents, mixed requests, follow-up steering, difficult/context-heavy tasks, no-match inputs, missing evidence and stale responses. Test deterministic policy with fabricated judgments separately from paid model evaluation.
- No native Jev feature discovered requires a custom orchestration framework. The justified custom code is project policy, lifecycle/state ownership and validation at the external-service boundary.
