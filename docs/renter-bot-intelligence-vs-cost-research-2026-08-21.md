# Making the renter bot smarter without raising cost — research, 2026-08-21

Brief: *"make the bot much more intelligent and understanding of context without
getting cost higher — a repo that helps these systems, or how others build
them."*

Findings are ordered by **value for this specific system**, and grounded against
what the repo actually does today rather than general advice.

## What we run today (verified, not assumed)

- Models: `google/gemini-3.7-flash` primary and smart lane,
  `anthropic/claude-sonnet-4.6` as smart fallback, via OpenRouter
  (`src/lib/ai-models.ts:52,65,81`).
- `src/mastra/agents/renter_bot.ts` is ~15.9 KB (≈4k tokens) of system prompt,
  plus `CONVERSATION_CRAFT` (~2 KB) and 7 tool schemas.
- **`grep -rn 'cache_control|cacheControl|cachePoint|promptCache' src convex`
  returns NOTHING.** No prompt caching anywhere.

So a ~5–7k-token static prefix is re-sent, uncached, on every single turn of
every conversation.

---

## 1. Prompt caching — biggest immediate win, zero intelligence risk

Not an optimisation of the model, just not paying twice for identical tokens.

- OpenRouter supports `cache_control` breakpoints for **both** Gemini and
  Anthropic, with the same API shape. Gemini cache reads bill at **0.25x**
  (75% off); Anthropic reads at **0.1x**.
- Anthropic writes cost 1.25x (5-min TTL) or 2.0x (1-hour); break-even is about
  **2 cache hits**. Our conversations are 3–5+ turns, so every thread past turn
  two is pure saving.
- OpenRouter applies **sticky routing** keyed on a `session_id` you pass — we
  already have a natural stable key in `thread_id`.
- Debug with the `cache_discount` field: negative on the write turn, positive on
  reads.

**Where to put the breakpoint:** after the system prompt + `CONVERSATION_CRAFT`
+ tool schemas (all static), and *before* the per-turn `groundTruth` block
(availability, prices, alternatives — changes every turn). That ordering matters:
a cache prefix must be byte-stable, so anything volatile has to come after it.

**Two things to verify before trusting it:**

1. **Does Mastra forward `cache_control`?** There is a known class of bug here —
   `pydantic-ai`'s `OpenRouterChatModel` inherits OpenAI base behaviour and
   *silently drops* CachePoint items ([pydantic-ai#4392]). A wrapper that
   silently no-ops would leave us thinking caching is on when it isn't. Check
   `cache_discount` on a real generation, don't assume.
2. **Minimum token threshold.** Sources disagree: OpenRouter's general Gemini
   figure is 4,096 tokens, while per-model tables list Gemini 2.5 Flash at
   1,024. Our prefix is around 5–7k so it likely clears either, but confirm for
   `gemini-3.7-flash` specifically — below the minimum, caching silently never
   starts.

---

## 2. GEPA — the actual answer to "smarter without costing more"

This is the one worth real attention, because **we just built the thing it
needs**.

GEPA (Genetic-Pareto) is a reflective prompt optimiser: ICLR 2026 **Oral**,
authors include DSPy's Omar Khattab, Matei Zaharia, Ion Stoica, Christopher
Potts and Dan Klein. It ships both as `dspy.GEPA` and standalone
([gepa-ai/gepa]). Reported to beat RL methods like GRPO by up to **20% with 35×
fewer rollouts**.

How it works: it keeps a pool of candidate prompts, runs them on a minibatch,
records execution traces (including **tool calls and tool outputs**), and a
**feedback function returns a scalar score plus textual feedback**, which an LLM
reflects on to mutate the prompt.

**Why this fits us unusually well:** that feedback function is the hard part for
most teams, and we already have it. `convex/lib/renter_bot_conversation_rubric.ts`
emits exactly that shape — a pass/fail per check plus `detail` and `evidence`
strings. Our 10 checks (false unavailability, cross-turn repetition, question
answered, substitution sanity, kit hallucination, day-count negotiation, lens
follow-through, price consistency, phantom product, unfounded absence) are a
ready-made GEPA metric, and
`scripts/renter-bot-conversation-test.mjs` is a ready-made rollout harness.

**Cost profile:** optimisation is a one-off offline spend. Runtime cost is
unchanged or *lower* — GEPA often finds shorter prompts, and a better-instructed
Flash needs fewer Sonnet escalations. That is the "more intelligent, not more
expensive" lever.

**Caveats worth respecting:**
- MAS-PromptBench (June 2026) found prompt optimisation becomes unpredictable on
  *multi-agent* systems. Ours is single-agent + tools, which is the case it works
  best on — but don't extend it to an orchestrator without re-checking.
- Decagon's production write-up ran 19+ ablations and concluded effectiveness
  depends heavily on configuration; a benchmark paper used system-aware merge,
  minibatch 3, 70/30 train/val.
- It optimises against whatever the metric says. Our rubric has already produced
  four false positives during this session — GEPA would happily overfit to
  those. **Fix rubric precision first, or it optimises toward the wrong thing.**

---

## 3. Semantic caching — I recommend AGAINST this for us

It is the most-hyped option and the worst fit here, so it's worth being explicit.

GPTCache-style semantic caching reuses a previous answer when a new query is
*similar enough*. Reported savings are real (30–70%; GPT Semantic Cache reports
up to 68.8% fewer calls). But the research states the limitation plainly:
existing caching was designed for **chatbots at query level, not agents at task
level**; it assumes a stateless prompt→response mapping and **fails where
outputs depend on external state queried at run time**.

Our bot is almost entirely external state — availability, per-account prices,
kit, calendar conflicts. "Is the FX3 free this weekend?" has a different correct
answer week to week and account to account. A false cache hit would resurrect
precisely the class of bug this whole session was spent eliminating: telling a
renter something is available when it isn't. The reported ordering guidance
agrees, putting semantic caching *after* prompt caching, routing and
right-sizing.

If it's ever revisited, the safe subset is **static-knowledge Q&A only** —
policy/FAQ answers with no dates, no prices, no availability — never the
grounded path.

---

## 4. Context trimming — real, but do it carefully

We inject a large `groundTruth` block each turn. Trimming it to only the facts
the current message needs is a genuine saving, and open tools exist in this
space (lean-ctx, RTK, mem0's compression claiming up to 80% reduction).

One interaction to note: **compaction invalidates the prefix cache**, so
compacting every few turns fights against item 1. Compact rarely, or only the
volatile tail.

## 5. Routing — we already have most of it

`CHAT_MODEL` / `CHAT_MODEL_SMART` / `CHAT_MODEL_SMART_FALLBACK` plus the existing
high-stakes escalation is already confidence-gated routing, which the 2026 cost
guides list as a top-three lever. Little to gain without measurement.

---

## Recommended order

1. **Prompt caching** — days of work, no behaviour change, verify with
   `cache_discount`. Biggest £ saving available right now.
2. **Tighten rubric precision** — prerequisite for anything automated.
3. **GEPA against the existing rubric + harness** — the real intelligence lever;
   offline cost, runtime neutral-to-cheaper.
4. **Context trimming** — after caching, and mindful of cache invalidation.
5. **Semantic caching** — only for static FAQ content, if ever.

## Sources

- [OpenRouter prompt caching docs](https://openrouter.ai/docs/guides/best-practices/prompt-caching) · [OpenRouter caching + sticky routing](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/)
- [pydantic-ai#4392 — wrapper silently drops CachePoint](https://github.com/pydantic/pydantic-ai/issues/4392)
- [Prompt caching cost math 2026](https://usagebox.com/articles/prompt-caching-cost-optimization-claude-gpt-gemini-2026) · [PromptHub caching comparison](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models)
- [gepa-ai/gepa](https://github.com/gepa-ai/gepa) · [Decagon: optimizing GEPA for production](https://decagon.ai/blog/optimizing-gepa-for-production) · [DSPy optimizers explained](https://futureagi.com/blog/dspy-optimizers-explained/) · [MAS-PromptBench](https://arxiv.org/pdf/2606.23664)
- [GPT Semantic Cache](https://arxiv.org/abs/2411.05276) · [ContextCache (multi-turn)](https://arxiv.org/pdf/2506.22791) · [Agentic Plan Caching](https://arxiv.org/pdf/2506.14852)
- [LangChain: context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents) · [bonigarcia/context-engineering](https://github.com/bonigarcia/context-engineering) · [Cutting LLM token costs 2026](https://wavect.io/blog/reduce-llm-token-costs-2026/)
