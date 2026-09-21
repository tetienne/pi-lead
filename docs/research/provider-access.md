# Provider access research

Checked 2026-09-21. Preimplementation research only; no credentials, auth files, account settings, or paid endpoints were accessed.

## OpenCode Go: verified service behavior

Go costs $10/month and supplies an API key. It supports coding agents beyond OpenCode and explicitly lists current Pi builds as validated clients, without guaranteeing future compatibility. Clients should identify themselves and send a stable `x-opencode-session` per conversation. [Official Go documentation](https://opencode.ai/docs/go/#where-can-i-use-it)

Limits are model-specific monthly dollar allowances, with five-hour and weekly ceilings of 20% and 50%. Published request counts are estimates. Enabling **Use balance** allows exhausted Go allowances to draw from Zen credits. Models, limits, and privacy policies vary; the current privacy table includes both zero-retention models and models with retention or training use. [Limits, overage, and privacy](https://opencode.ai/docs/go/)

The service exposes Chat Completions, Messages, and Responses endpoints according to model, plus a model metadata endpoint. [Endpoints](https://opencode.ai/docs/go/#endpoints)

## Installed Pi: verified native support

The inspected installation is `@earendil-works/pi-coding-agent` 0.86.1. Sources below are shipped package code, not user configuration. Package root:

`/Users/Thibaut/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/lib/node_modules/@earendil-works/pi-coding-agent`

| Finding | Installed primary source, relative to package root |
| --- | --- |
| Built-in provider ID is `opencode-go`; accepts `OPENCODE_API_KEY` or Pi's native API-key auth storage. | `docs/providers.md` |
| Built-in adapters cover Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. | `node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js` |
| Adapter wrapper derives `x-opencode-session` from `sessionId`, preserving an explicit existing header. | `node_modules/@earendil-works/pi-ai/dist/providers/opencode-headers.js` |
| Coding-agent attribution supplies `x-opencode-session` and `x-opencode-client: pi`. | `dist/core/provider-attribution.js` |
| Release 0.86.0 fixed inherited OpenCode session headers across supported adapters. | `CHANGELOG.md`, 0.86.0 Fixed, issue #9326 |
| Packaged model records already contain Go endpoints and adapter-specific compatibility metadata. | `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json` |

Upstream references: [provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [session-header issue](https://github.com/earendil-works/pi/issues/9326). Installed files establish version-specific behavior; `main` may change.

**Design inference:** use Pi's native provider and catalog. Installing OpenCode CLI, writing a provider SDK, or maintaining another model table is unnecessary for basic Go access. Preserve native session identity through the eventual network boundary. Source inspection establishes capability, not successful authenticated execution inside Gondolin. User-agent behavior and all selected model paths still need an eventual isolated integration check.

## ChatGPT Pro: subscription path and sandbox gap

The user's Q9 answer is interpreted as confirming ChatGPT Pro after the naming clarification. Installed Pi `docs/providers.md` lists ChatGPT Plus/Pro through native Codex OAuth. This establishes Pi support, not an authenticated integration test.

OpenAI distinguishes ChatGPT sign-in for subscription access from API keys for usage-based billing. A Platform API key would not make ordinary API calls part of the user's Pro allowance. [Official authentication documentation](https://learn.chatgpt.com/docs/auth)

Included limits and available purchased credits are distinct. The public pricing page says available credits can continue usage after included limits; selecting subscription authentication alone does not prove zero additional paid usage. Account controls and quota handling must be verified before live autonomy. [Official pricing documentation](https://learn.chatgpt.com/docs/pricing)

**A plain Gondolin placeholder is insufficient for Pi's Codex adapter.** Installed `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:165–169` calls `extractAccountId` before networking. At lines 1250–1262 that function splits the supplied token, decodes its JSON claims and requires `https://api.openai.com/auth.chatgpt_account_id`; header construction subsequently sends both bearer authorization and account ID. This is inspected package source, not any user's token. [Upstream adapter source](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts)

Design implications: preserve real access/refresh tokens on the trusted host. Investigate whether a non-secret, parseable guest placeholder plus host-side header substitution and native refresh support suffices; otherwise assess a narrowly scoped host auth adapter. Neither option has been tested. Do not expose the real token to make the existing adapter work. The user reports OpenCode Go currently out of quota, so ChatGPT Pro is required for the first real isolated worker despite its more involved auth path.

Follow-up [ChatGPT isolation research](chatgpt-isolation.md) identifies a source-supported native composition, including the explicit provider-auth overlay required in addition to the placeholder, native host refresh/secret rotation, and restricted SSE transport. This narrows the design without claiming runtime validation.

## Decisions and implementation consequences

- The user prefers worker usage within existing subscriptions, with no paid fallback authorized. Jev will use OpenRouter with an approved $1/day ceiling, not a spending target.
- Proposed policy: stop or defer work at provider exhaustion; no paid fallback unless explicitly authorized. Pi-side cost estimates cannot establish the account's remaining entitlement or disable a provider-side overage option.
- Check the chosen Go account's **Use balance** setting with the user before live autonomy; this research did not inspect it. Do not automatically change billing settings.
- Keep the accepted two-worker limit; throttle below it when provider limits require. The inspected sources do not establish a numeric concurrent-request allowance for this account.
- Select concrete worker models later against task quality, privacy requirements, and actual entitlement. Native support does not imply every listed model is suitable or available to this account.
- Determine how the isolation layer supplies a credential placeholder while keeping the actual API key outside the worker. Native environment-variable support is an integration mechanism, not evidence that exposing a real key inside the guest is acceptable.

No provider account action or runtime validation was performed.
