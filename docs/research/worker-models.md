# Worker models: ChatGPT Pro and OpenCode Go

Checked 2026-09-23, the day after OpenAI released GPT-6 Sol and GPT-6 Luna
(2026-09-22). This note chooses the model and thinking level behind each tier that
Jev's difficulty judgment selects. Sources are Pi's packaged catalogs
(`@earendil-works/pi-ai` 0.86.1 and 0.87.1, `dist/providers/data/*.json`) and
the public announcements linked below. No model was called and no account was
inspected.

## How a Jev answer becomes a model

1. `Judge.modelTier` asks Jev for a 0–4 difficulty score (`DIFFICULTY_RUBRIC` in
   `src/jev.ts`).
2. `tierForDifficulty` maps the score to a tier: below 1.5 → `fast`, below 2.8 →
   `standard`, otherwise → `deep`. `debug` and `review` never go below
   `standard`. When Jev is unavailable or unsure, the default is `standard`, or `deep`
   for `debug`/`review` (`src/delegate.ts`).
3. `resolveRoute` (`src/model-routing.ts`) turns the tier into a model: the tier's
   `model`, then each `fallbacks` entry in order, then the Lead's own model.
   A model counts as available when Pi's catalog has it and its provider has auth.
4. When a worker runs out of quota, the worker extension reports it (Pi never
   retries quota errors). The Lead then skips that provider until its reset
   (ChatGPT's delay, at least 5 min). Without a delay it waits 5 min for ChatGPT,
   because Pi reports every ChatGPT 429 as a "usage limit", and 60 min otherwise. It restarts the task on the tier's
   next available model, from the branch so far. With no other model, the worker
   reports `blocked` and waits in its tab.

## ChatGPT Pro (`openai-codex` provider)

| Pi id | In Pi | Context | Thinking levels | API price in/out $/M (a proxy for quota weight) |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | 0.86.1 | 272k | off…max | 10 / 50 |
| `gpt-6-sol` | **0.87.1** | 272k | off…max | 2 / 10 |
| `gpt-6-luna` | **0.87.1** | 272k | off…max | 0.10 / 0.50 |
| `gpt-5.6-sol` | 0.86.1 | 272k | minimal→low…max | 4 / 20 (was 5 / 30 in 0.86.1) |
| `gpt-5.6-terra` | 0.86.1 | 272k | minimal→low…max | 2 / 12 |
| `gpt-5.6-luna` | 0.86.1 | 272k | minimal→low…max | 0.20 / 1.20 |
| `gpt-5.5`, `gpt-5.3-codex-spark` | 0.86.1 | 272k / 128k | minimal→low…xhigh | 5 / 30, 1.75 / 14 |

- **Astra** is OpenAI's flagship: state of the art on software engineering, computer use
  and cybersecurity. Third-party Terminal-Bench 4.0 runs put it in the high 50s.
- **Sol** is aimed at "complex coding and tasks that use several tools or steps".
  It costs half of GPT-5.6 Sol. Terminal-Bench 4.0 low 40s, SWE-Bench Pro 64.6 %,
  DeepSWE v1.1 68.8 % at max effort. OpenAI did not publish its own
  SWE-bench/Terminal-Bench figures, so these numbers come from third parties.
- **Luna** is aimed at low-cost, high-volume work, yet it scores DeepSWE v1.1 66.6 %
  at max effort, close to Sol. It costs half of GPT-5.6 Luna.
- Sol and Luna are in Codex for Plus/Pro/Business/Enterprise/Edu since
  2026-09-22. **They need Pi ≥ 0.87.1**; with 0.86.1 `resolveRoute` sees them
  as unavailable and moves on to the next fallback.
- GPT-5.6 models are dominated by their GPT-6 counterparts on price and
  (per OpenAI) quality, so none is used below.

## OpenCode Go (`opencode-go` provider)

The Go subscription costs $10/month, with dollar-based allowances (about $12 per 5 h,
$30 per week, $60 per month). Each request draws on that allowance at the model's
price. Pi 0.87.1 lists 30 models; the ones relevant to coding workers are:

| Pi id | Context | Supported thinking levels | $/M in/out | Approx. requests / 5 h |
| --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1M | low, high, max | 0.15 / 0.60 | thousands |
| `glm-5.3-flash` | 1M | low, high, max | 0.15 / 0.50 | ~6,300 |
| `glm-5.3` | 1M | low, high, max | 1.40 / 4.40 | hundreds |
| `deepseek-v4-pro` | 1M | high, max | 0.66 / 1.98 | hundreds |
| `qwen3.8-max` | 1M | low, medium, xhigh | 2 / 6 | — |
| `grok-4.7` (new in 0.87.1) | 500k | low…xhigh | 2 / 6 | — |
| `kimi-k3` | 1M | max only | 3 / 15 | ~110 |
| `gpt-5.6-luna` | 1.05M | low…max | 0.20 / 1.20 | — |

No GPT-6 model is on Go. An agentic worker can make 50–150 requests per task,
so Kimi K3's ~110 requests per 5 h cannot carry a whole ticket and it is left out.
The **Use balance** setting must stay off so that exhausted quota never spends
Zen credits (see ticket 09).

## Mapping

| Jev difficulty (kind) | Tier | Primary: ChatGPT Pro | Fallback: OpenCode Go |
| --- | --- | --- | --- |
| < 1.5, implement/prototype/research | `fast` | `openai-codex/gpt-6-luna` · medium | `opencode-go/deepseek-v4.1-flash` · high |
| 1.5–2.7, or any debug/review below 2.8, or Jev unavailable | `standard` | `openai-codex/gpt-6-sol` · high | `opencode-go/glm-5.3` · high |
| ≥ 2.8, or debug/review with Jev unavailable | `deep` | `openai-codex/gpt-6-astra` · xhigh | `opencode-go/deepseek-v4-pro` · max |

Why these choices:

- **fast → Luna medium.** Luna is almost as strong as Sol on agentic coding and
  costs a twentieth as much, which suits trivial and easy tickets. `low` is too
  terse for a worker that must still run tests and call `finish`.
- **standard → Sol high.** This is the tier most tickets land in, and Sol is
  OpenAI's intended model for multi-step tool use. `high` rather than `xhigh`
  keeps Pro quota for the deep tier.
- **deep → Astra xhigh.** Only hard, cross-cutting or deep-debugging work gets here,
  where Astra's lead over Sol (about 15 Terminal-Bench points) is worth its price.
  `max` stays a manual choice.
- Go fallbacks use only thinking levels their catalog entry supports, so Pi
  does not clamp them silently.

Configuration (`~/.pi/agent/pi-lead.json`):

```json
{
  "tiers": {
    "fast": {
      "model": "openai-codex/gpt-6-luna", "thinking": "medium",
      "fallbacks": [{ "model": "opencode-go/deepseek-v4.1-flash", "thinking": "high" }]
    },
    "standard": {
      "model": "openai-codex/gpt-6-sol", "thinking": "high",
      "fallbacks": [{ "model": "opencode-go/glm-5.3", "thinking": "high" }]
    },
    "deep": {
      "model": "openai-codex/gpt-6-astra", "thinking": "xhigh",
      "fallbacks": [{ "model": "opencode-go/deepseek-v4-pro", "thinking": "max" }]
    }
  }
}
```

## Limits

- No live run: this mapping has not been tested against a real account. Go was
  last seen out of quota (ticket 09).
- Exhausted providers are remembered by the Lead process only. A new Lead
  session tries them again once and learns from the first failure.
- The Go benchmark standings are thin. Revisit `standard`/`deep` fallbacks once
  real worker runs give evidence.

## Sources

- [Introducing GPT-6 Sol and Luna (OpenAI)](https://openai.com/index/introducing-gpt-6-sol-and-luna/)
- [GPT-6 Astra (OpenAI)](https://openai.com/index/gpt-6-astra/)
- [TechCrunch: GPT-6 Sol and Luna](https://techcrunch.com/2026/09/22/openai-launches-gpt-6-sol-and-luna/)
- [Vellum: GPT-6 Sol and Luna benchmarks](https://www.vellum.ai/blog/gpt-6-sol-and-luna-benchmarks-explained)
- [OpenCode Go documentation](https://opencode.ai/docs/go/)
- [BSWEN: OpenCode Go models, limits](https://docs.bswen.com/blog/2026-09-04-opencode-go-models/)
- Pi catalogs: `@earendil-works/pi-ai` 0.86.1 and 0.87.1, `dist/providers/data/openai-codex.json` and `opencode-go.json`
