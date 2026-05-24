# WallE Model Swap Procedure

## Why

WallE chat snapshot fixes (commit `f48ec11f`) make the dashboard data we feed the LLM accurate and labeled. The remaining quality gap is the **model itself**: `deepseek/deepseek-chat` (free) tends to embellish and ignore explicit label semantics — even when handed a clean snapshot block, it will paraphrase `mtdEarningsNet` as "revenue" or invent percentages.

Swapping to Claude Haiku 4.5 (via OpenRouter) closes that gap because Haiku follows label semantics tightly and respects the system prompt's "report only what is in the snapshot" rule.

## Current vs Recommended

| | Current | Recommended |
|---|---|---|
| Env var | `DEEPSEEK_MODEL=deepseek/deepseek-chat` | `DEEPSEEK_MODEL=anthropic/claude-haiku-4.5` |
| Pricing | Free (OpenRouter) | ~$1 / 1M input tokens, ~$5 / 1M output tokens |
| Behavior | Prone to embellishment, drifts from labels | Tight label semantics, low hallucination |
| Provider | OpenRouter | OpenRouter (Anthropic backend) |

Estimated cost: a typical WallE chat snapshot + response is well under 5K tokens. At Haiku 4.5 rates that is fractions of a cent per chat.

## Steps (Daniel — Vercel UI)

This is a **deployment-time env change**. Code cannot deploy it; the value lives in Vercel.

1. Vercel dashboard → project **rental-manager-v2**
2. Settings → Environment Variables
3. Find `DEEPSEEK_MODEL` for the **Production** environment
4. Update value to: `anthropic/claude-haiku-4.5`
5. Save
6. Deployments → latest production deploy → **Redeploy** (or push any new commit to trigger)

## Pre-flight checks

- `OPENROUTER_API_KEY` is unchanged — same key works for Anthropic models routed through OpenRouter.
- OpenRouter account must have **Anthropic provider enabled** (default for paid accounts; check OpenRouter dashboard → Providers).
- No code change required. The chat/narrate routes already read `process.env.DEEPSEEK_MODEL` and pass it through to OpenRouter unchanged.

## Rollback

If Haiku output is worse than expected, revert the env var to `deepseek/deepseek-chat` and redeploy. No code rollback needed.

## Verification post-swap

- Open WallE on production dashboard, ask: *"What was my net take-home this month?"*
- Expect: the exact `mtdEarningsNet` figure from the snapshot, with no extra invented context.
- Ask: *"What is my top utilizer?"*
- Expect: real `topUtilization.utilizationPct` value, not a WoW delta % from `topWoWMover`.
