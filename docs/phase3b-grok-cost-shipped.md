# Phase 3b: Grok Cost Reduction — Shipped Runbook

**Branch:** `phase3b-grok-cost`  
**Tip commit:** `686c1ef`  
**Test status:** 57/57 vitest green  
**Files changed:** 9 files, +542 / -35 LOC  
**Date shipped:** 2026-05-15

---

## TL;DR

7 actions + 3 fixup tightenings targeting ~$95–125/mo in Grok API savings on the Rental Manager dashboard chat and AI-decision surfaces. No schema changes. No data migrations. Safe rollback via `git revert`. Savings are **theoretical until production billing data validates** (see Monitoring section).

---

## Commit Chain

```
686c1ef fixup(phase3b): classifier exact-match (H1), thread_id guard (H3), maxOutputTokens 1800 chat (M3)
ad6aaa9 feat(phase3b/w3): classify-intent router + dashboardChatAgentFast dual-agent
a65c6bb feat(phase3b/w2b): enrich query_alerts description for on-demand alert fetching
<w2a>   feat(phase3b/w2a): trim getContextBundle injection (-352 chars, ~88 tok saved)
<w1d>   feat(phase3b/w1d): thread abortSignal through to agent.stream
<w1c>   feat(phase3b/w1c): Mastra modelSettings.maxOutputTokens — chat 1200, decision 600
8095846 feat(phase3b/w1b): GROK_DECISION_MODEL env var, swap ai-decision to grok-4-fast default
c8d2420 feat(phase3b/w1a): x-grok-conv-id caching header + cached_tokens metadata wiring
```

Run `git -C /tmp/rmv2-phase3b log --oneline main..phase3b-grok-cost` for live hashes.

---

## Wave-by-Wave Summary

### W1a — xAI Prompt Caching Header (`c8d2420`)

**What:** Wired `x-grok-conv-id: <thread_id>` header on the xAI client at two LLM surfaces: `dashboard-chat.ts` (per chat thread) and `ai-decision.ts` (per Hygglo order). Also captures `cached_tokens` from stream metadata and persists it into `dashboard_chat_messages.metadata`.

**Why:** xAI's prompt-caching opt-in requires this header. Without it, every turn re-ingests the full system prompt and conversation prefix at full token cost.

**Scope:** 6 single-shot Trigger/Convex sites (`resolve-items`, `canonicalize-denials`, `vision-resolve`, `extract-booking-times`, `vision_resolver`, `item_resolver`) left unmodified — single-shot calls have no stable per-conv id and no caching benefit.

**Fixup (H3):** Empty/falsy `thread_id` (e.g. `""` from a fresh modal) no longer sends `x-grok-conv-id: ""` (which would collide all such requests under one cache key). Header is now conditionally omitted:
```ts
const xGrokHeaders: Record<string, string> = convId
  ? { "x-grok-conv-id": convId }
  : {};
```

**Estimated savings:** ~$30/mo (theoretical)

---

### W1b — GROK_DECISION_MODEL Env Var (`8095846`)

**What:** Added `GROK_DECISION_MODEL` environment variable with default `"grok-4-fast"`. The `ai-decision` agent now reads this env var at construction time instead of hardcoding the model name.

**Why:** AI-decision calls are JSON-constrained, short-output, and high-frequency (one per Hygglo order poll). grok-4-fast is sufficient for structured accept/decline decisions.

**Estimated savings:** ~$32/mo (theoretical)

---

### W1c — Mastra `modelSettings.maxOutputTokens`

**What:** Set `modelSettings: { maxOutputTokens: 1200 }` on chat agent construction, `600` on decision agent. Prevents runaway generation on over-eager responses.

**Fixup (M3):** Chat cap raised to `1800` after adversarial review identified that 1200 tokens truncates legitimate list responses (71 inventory items × ~17 tokens each approaches the limit). Decision agent remains at `600` (constrained JSON). All 3 chat agent model entries updated (lines 86, 93, 139 of `dashboard-chat.ts`).

**Estimated savings:** ~$5–10/mo (theoretical)

---

### W1d — `req.signal` → `abortSignal` Threading

**What:** Passes `req.signal` (HTTP request abort signal) through to `agent.stream()` as `abortSignal`. When the user closes the browser tab or navigates away, the in-flight LLM call is cancelled at the AI SDK layer.

**Caveat (M2):** xAI server-side billing behaviour on client disconnect is unverified. The AI SDK passes `signal` to `fetch`, but xAI may continue generating asynchronously and bill for all tokens generated before TCP close. The $5/mo savings estimate is speculative pending one week of billing dashboard monitoring post-deploy.

**Estimated savings:** ~$5/mo (theoretical, M2 caveat applies)

---

### W2a — `getContextBundle` Injection Trim

**What:** Removed the `alerts` block from `getContextBundle`. Bundle reduced from ~870 chars to ~518 chars, saving approximately 88 tokens per chat turn on the injected context prefix.

**Why:** Alert data was injected unconditionally on every turn even when the user's query had nothing to do with alerts. Moving it to on-demand fetching (W2b) preserves the information while eliminating the per-turn token cost.

**Estimated savings:** ~$8/mo combined with W2b (theoretical)

---

### W2b — `query_alerts` Description Enriched (`a65c6bb`)

**What:** Enriched the `query_alerts` tool description with trigger keywords so the model knows when to call it: briefing, pending, today, overdue, shadow actions, model upgrades.

**Why:** With alerts removed from the bundle (W2a), the model must self-select to fetch them. The enriched description provides the nudge without injecting alert data unconditionally.

**Gap noted (M4):** "conflicts", "double-booking", "untracked claims" not yet in the tool description — coverage exists at system prompt level but not in tool description. Phase 3b.2 item.

---

### W3 — Rule-Based Intent Classifier + Dual-Agent Router (`ad6aaa9`)

**What:** New `classify-intent.ts` module with a rule-based `classifyIntent(message, history)` function. New `getDashboardChatAgentBundle(convId)` returns `{ full, fast }` agent pair. `route.ts` classifies the user message before streaming and picks the appropriate agent.

**Routing logic (priority order):**
1. Empty/whitespace → `unknown` → grok-4.3
2. Mutation keyword match → `mutation` → grok-4.3
3. Message length > 240 chars → `complex` → grok-4.3
4. Sentence-ender count ≥ 3 → `complex` → grok-4.3
5. Complex keyword match → `complex` → grok-4.3
6. Recent assistant turn called `mutate` tool → `complex` → grok-4.3
7. Simple-read keyword match → `simple_read` → grok-4-fast
8. Default → `unknown` → grok-4.3

**Bias:** default-on-uncertainty routes to the full model (safe, no correctness loss). `intent` and `routed_model` persisted to `dashboard_chat_messages.metadata`.

**Fixup (H1):** Classifier's `recentMutateContext` check replaced substring scan (`/\bmutate\b/.test(md)`) with structured tool-call regex `(?:"tool"|"name"|'tool'|'name')\s*:\s*(?:"mutate"|'mutate')` — prevents false positives when the assistant describes a mutation in prose ("I will mutate the record…").

**New files:** `classify-intent.ts`, `classify-intent.test.ts` (11 test cases, +11 to vitest suite = 57 total).

**Estimated savings:** ~$25/mo conditional on classifier accuracy (~50% simple_read hit rate on typical operator chatter per adversarial L4 sample)

---

## Cost Impact Estimates

All figures are theoretical until 7-day post-deploy billing data validates them.

| Source | Mechanism | ~$/mo |
|---|---|---|
| W1a — prompt caching | `x-grok-conv-id` header; system prompt + history prefix cached by xAI | ~$30 |
| W1b — model swap | grok-4-fast for ai-decision (JSON-constrained, high-frequency) | ~$32 |
| W1c + M3 — output cap | `maxOutputTokens` 1800 chat / 600 decision prevents runaway generation | ~$5–10 |
| W1d — abort signal | Early cancellation on disconnect (M2 caveat: xAI billing unverified) | ~$5 |
| W2a + W2b — bundle trim | Alerts removed from every turn; ~88 tok/turn saved | ~$8 |
| W3 — router split | ~50% turns routed to grok-4-fast (~10× cheaper per token) | ~$25 |
| **Total addressable** | | **~$95–125/mo** |

---

## Monitoring — Verify Savings Post-Deploy

After `npx convex deploy --yes`, wait 24h before reading these signals.

### 1. Prompt Caching Active
```
# Convex dashboard or query:
db.query(api.dashboard_chat.listMessages, { limit: 50 })
  → filter metadata.cached_tokens > 0
```
If `cached_tokens` is consistently 0 after 24h, the `x-grok-conv-id` header is not reaching xAI — check that the env `XAI_API_KEY` is set and that requests reach the xAI endpoint (not a mock/proxy).

### 2. Model Distribution
```
# metadata.model should reflect grok-4-fast for ai-decision turns
# metadata.routed_model should show fast/full split for chat turns
```
Expected: majority of simple "what's today's revenue?" turns → `grok-4-fast`. Mutation and complex turns → `grok-4.3`.

### 3. Router Accuracy Baseline
Aggregate `routed_model` over first 7 days:
- `simple_read` share < 20% → classifier too conservative (no savings from W3)
- `simple_read` share > 70% → classifier too aggressive (correctness risk)
- Target: 40–55% simple_read for typical dashboard operator usage

### 4. Token Trend
```
# Compare 7d pre-deploy vs 7d post-deploy:
aggregate(metadata.input_tokens) WHERE source = "chat"
```
Expect 15–30% reduction in average input tokens per turn (W1a caching + W2a trim).

### 5. Abort Signal Billing (M2)
Monitor xAI billing dashboard for one week. Look for billing line items on calls that were client-aborted mid-stream. If billed fully → W1d $5/mo estimate is $0.

---

## Open Concerns — Phase 3b.2 Monitoring Deliverables

These were flagged by adversarial sweep (w4b) and not fully resolved in Phase 3b:

| ID | Concern | Action |
|---|---|---|
| M1 | Per-thread LRU cap: `PER_THREAD_CLIENT_CAP = 256` now holds `{full, fast}` pairs (~3× memory). Under burst (300 unique threads/5 min) eviction churn destroys caching benefit. | Track LRU hit rate post-deploy. Raise cap to 512 if memory pressure allows. |
| M2 | `abortSignal` → xAI billing unverified. xAI may continue generating after TCP close. | Monitor billing dashboard 7 days; adjust $5/mo estimate. |
| M6 | `routed_model` logged to metadata but no aggregation query committed. Manual SQL required for savings validation. | Add Convex query `getRoutingDistribution(daysBack)` + hub surface. |

Additional classifier gaps (not blocking, Phase 3b.2):
- Add `refund`, `payout`, `claim` to mutation keyword list (H2)
- Add `conflicts`, `double-booking`, `untracked claims` to `query_alerts` description (M4)
- Anchor `set ` and `who `/`when `/`where ` keywords to avoid mid-word false positives (L1, L2)

---

## Deployment Notes

1. **Merge** `phase3b-grok-cost` → `main`. Use `--no-ff` if main has automation commits since branch point.
   ```bash
   git checkout main
   git merge --no-ff phase3b-grok-cost
   ```

2. **Deploy Convex functions:**
   ```bash
   npx convex deploy --yes
   ```
   Re-check Convex billing plan if the prior billing block is still active.

3. **Push:**
   ```bash
   git push origin main
   ```

4. **Vercel** auto-deploys on push to main. No manual action required.

5. **Environment variables:** No new env vars required. `GROK_DECISION_MODEL` defaults to `"grok-4-fast"` if unset. Override only if targeting a different fast model tier.

---

## Rollback

No schema changes. No data migrations. Each commit is independently revertable:

```bash
git revert 686c1ef  # fixup
git revert ad6aaa9  # W3 router
git revert a65c6bb  # W2b alerts description
# ... continue per commit
```

Re-run `npx convex deploy --yes` after reverting. No data loss risk.

---

## Not in Scope — Phase 3c

The following items were evaluated but deferred:

- **Mastra Memory** — persistent cross-session memory layer
- **Langfuse** — LLM observability / cost analytics platform
- **`@convex-dev/ratelimit`** — Convex-native rate limiting
- **Convex `vectorIndex`** — semantic search on inventory/bookings
- **Stagehand + Browserbase** — browser automation for Hygglo scraping
- **`dldr`** — deduplicating loader for Convex queries
- **Mistral OCR** — document extraction for insurance claims

---

## Cross-Links

- [Phase 1 docs](../docs/phase1-shipped.md) — initial Mastra + xAI wiring
- [Phase 1c docs](../docs/phase1c-shipped.md) — Hygglo date fix + calendar hardening
- [Phase 2 docs](../docs/phase2-shipped.md) — dashboard MV + revenue pipeline
- [Phase 3a docs](../docs/phase3a-shipped.md) — AI-decision + polling hardening
- Phase 3b reports: `/tmp/wfo-phase3b/` (W0–W5 wave reports + adversarial + fixup)
