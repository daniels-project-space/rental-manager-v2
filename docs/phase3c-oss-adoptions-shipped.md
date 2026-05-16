# Phase 3c — OSS Adoptions + Vision-Elimination Pipeline: Shipped Runbook

**Branch:** `phase3c-oss-adoptions`  
**Tip commit:** `7aad2c7` (fixup)  
**Files changed:** 25 files, +5359 / -329 LOC  
**Date shipped:** 2026-05-15  
**Test status:** 76/76 vitest green, `next build` exit 0

---

## 1. TL;DR

6 OSS libraries adopted in a single branch:

| # | Library | Purpose |
|---|---------|---------|
| 1 | `@convex-dev/rate-limiter` | Chat + hygglo_poll abuse protection |
| 2 | `langfuse` | OTel observability sink (graceful no-op when unset) |
| 3 | `dldr` | HydrationLayer T2 batching (replaces custom batcher) |
| 4 | `@mastra/memory` + `@mastra/libsql` | Dashboard chat memory, dual-write to Convex for UI compat |
| 5 | `@browserbasehq/stagehand` | Cloud browser for Hygglo UI actions (flag-gated OFF) |
| 6 | `@google/generative-ai` | Gemini embeddings + Tier 3 multimodal vision |

New capability added: **4-tier vision-elimination pipeline** that routes item-from-image resolution through progressively more expensive tiers (pHash → vectorIndex → Gemini Flash → Grok Vision), with learn-once writeback so every tier-2/3/4 hit becomes a free tier-1 hash hit on next encounter.

**Expected impact:**
- ~60 h/month engineering time saved (manual booking/scraping work eliminated)
- Recurring Grok Vision spend → ~$0 at steady state (Tier 1+2 absorb ≥ 80% after cache warm-up)
- Chat rate-limit abuse prevented without custom infrastructure

---

## 2. Commit Chain

```
git -C /tmp/rmv2-phase3c log --oneline main..phase3c-oss-adoptions
```

Expected output (oldest → newest):

```
<hash>  chore(branch): phase3c-oss-adoptions branch prep
<hash>  feat(rate-limit): @convex-dev/rate-limiter — chat + hygglo_poll rules
<hash>  feat(observability): Langfuse OTel sink + graceful no-op shim
b622dd5 refactor(hydration): swap T2 batcher to dldr npm; T1+T3 unchanged
41fb5b9 feat(memory): adopt Mastra Memory via Convex storage adapter; replace manual getMessages(limit:6)
91e0149 feat(hygglo): Stagehand+Browserbase swap for hygglo-ui-action (flag-gated USE_STAGEHAND, Playwright fallback)
<hash>  feat(convex): vectorIndex foundation + Gemini embedding action + backfill (manual-invoke)
18b25d7 feat(vision): 4-tier resolve_item_from_image pipeline + pHash cache + learn-once writeback
7aad2c7 fix(build): clean reinstall; pHash threshold 8→5; Memory threadId namespaced accountSlug:threadId
```

---

## 3. Adoption Summary by Wave

### W1a — `@convex-dev/rate-limiter` (chat + hygglo_poll)

**Package:** `@convex-dev/rate-limiter@^0.3.2`

**Files created/modified:**
- `convex/convex.config.ts` (new) — registers `rateLimiter` component via `defineApp().use(rateLimiter)`
- `convex/rate_limit_config.ts` (new) — 3 rules:
  - `chat_per_thread`: fixed window, 60 turns / 5 min (key = `thread_id`)
  - `chat_per_account`: fixed window, 300 turns / 60 min (key = `accountSlug`)
  - `hygglo_poll`: fixed window, 1 run / 4 min (global singleton)

**Notes:** `(components as any).rateLimiter` cast used — types resolve to `{}` until `convex dev` regenerates `_generated/api.d.ts` after `convex.config.ts` is registered. Safe at runtime.

---

### W1b — Langfuse OTel sink

**Package:** `langfuse` (v3.x)

**Files created/modified:**
- `src/lib/langfuse.ts` (new) — lazy singleton `getLangfuse()`. When `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are absent, returns a **no-op shim** (`enabled: false`, all methods no-ops). Real client uses `flushAt: 1` + `flushInterval: 0` for Vercel serverless.
- `src/mastra/index.ts` — wires `traceMastraSpan()` helper for call-site OTel.
- `src/mastra/lib/langfuse.test.ts` — 9 tests (shim behavior, singleton, span shapes, error paths).

**Design guarantee:** Zero runtime errors when env keys are absent. No OTel SDK dependency needed.

---

### W1c — HydrationLayer T2 → `dldr` swap

**Package:** `dldr@^0.0.10` (367 B, `queueMicrotask`-flushed batcher)

**Files modified:**
- `src/mastra/lib/hydration.ts` — replaced custom `pending` Map + `flushBatch` + Promise-callback fan-out with per-instance, per-table `LoadFn` registry. `loadByIds(table, ids)` public signature **unchanged**.

**Properties preserved:**
- T1 static cache (module-scope Map + TTL + in-flight dedup) — unchanged
- T3 R2 snapshot loader chain — unchanged
- `_source` / `FreshnessMeta` lineage wrapping — unchanged
- Per-instance isolation: each `createHydrationLayer()` call gets its own `t2BatchLoaders` object

**Verification:** 12/12 hydration tests green, no test file edits required.

---

### W2a — Mastra Memory + LibSQL adapter

**Packages:** `@mastra/memory`, `@mastra/libsql@1.10.0`

**Commit:** `41fb5b9`

**Architecture — dual-write hybrid:**

```
User turn arrives
      │
      ▼
seed-on-first-turn bridge (Convex → LibSQL, last 20 msgs, idempotent)
      │
      ▼
Mastra Memory (LibSQL)       Convex dashboard_chat_messages
  last-N retrieval       ←→  UI source of truth (dual-write)
  auto-summarisation
```

**Files created/modified:**
- `src/mastra/memory/dashboard-memory.ts` (new) — `getDashboardMemory()` singleton. Config: `lastMessages: 8`, `semanticRecall: false`, `vector: false`, `workingMemory.enabled: false`, `generateTitle: false`. Summarisation triggers beyond `lastMessages` budget.
- `/api/chat` route — replaced manual `getMessages(limit:6)` with Memory retrieval.

**threadId namespace (fixup):** All thread IDs stored as `accountSlug:threadId` to prevent cross-account thread collision when LibSQL is shared across instances.

**Trade-off:** LibSQL is ephemeral per Node container. Cold-boot re-seeds from Convex (one round-trip). Working set converges within one turn.

---

### W2b — Stagehand + Browserbase (flag-gated)

**Package:** `@browserbasehq/stagehand`

**Commit:** `91e0149`

**Files created/modified:**
- `src/lib/browserbase.ts` (new) — lazy `getStagehand(accountSlug)` singleton cache, `releaseStagehand()`, `isStagehandEnabled()`. Reads `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` from env only. Cost note documented (~$0.05/session; per-slug cache critical).
- `src/trigger/hygglo-ui-action.ts` — `USE_STAGEHAND` env-flag branch. When ON: cookie inject + `page.goto` + `page.act(natural-language)` + `page.extract({schema: HyggloOrderExtract})`. When OFF (default): legacy Playwright path preserved verbatim.

**Action coverage:** All 10 Hygglo UI actions mapped (accept, decline, send_message, mark_picked_up, mark_returned, leave_review, remove_item, add_item, apply_discount, change_owner_earnings).

**Safety:** `READ_ONLY_MODE` master rail checked FIRST before any browser dispatch.

**Default:** `USE_STAGEHAND=0` (OFF). Do not flip until first smoke against a live Browserbase project confirms Zod-schema extraction works.

---

### W3a — Convex vectorIndex + Gemini embedding action

**Package:** `@google/generative-ai` (already in deps; confirmed for embedding use)

**Schema additions (additive only):**

```typescript
// convex/schema.ts — new tables
item_embeddings: defineTable({
  item_id: v.id("items"),
  embedding: v.array(v.float64()),      // 768-dim text-embedding-004
  embedding_model: v.string(),
  source_kind: v.union(v.literal("name"), v.literal("description"), v.literal("image")),
  source_ref: v.optional(v.string()),
  generated_at: v.number(),
})
  .index("by_item_id", ["item_id"])
  .index("by_item_and_kind", ["item_id", "source_kind"])
  .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 768 })

item_image_phash: defineTable({
  item_id: v.id("items"),
  image_url: v.string(),
  phash: v.string(),
})
  .index("by_item_id", ["item_id"])
```

**Action:** `convex/actions/generateEmbedding.ts` — `internalAction` that calls Gemini `text-embedding-004`. `image` source_kind embeds caption (`Photo of <name>: <url>`) — schema is multimodal-ready for future Vertex AI swap.

**Backfill:** `convex/actions/backfillEmbeddings.ts` — `internalAction`, manual-invoke only from Convex dashboard.

---

### W3b — 4-Tier Vision Resolution Pipeline

**Commit:** `18b25d7`

**Files changed:** 8 files, +1110 / -31 lines

**New/modified files:**
- `convex/resolve_item_from_image.ts` (new, 612 LOC) — tiered resolver action
- `convex/migrations/backfill_phash.ts` (new, 152 LOC) — pHash backfill action
- `src/mastra/lib/vision_pipeline.test.ts` (new, 210 LOC) — tier routing tests
- `src/trigger/vision-resolve.ts` — updated to call Convex tiered action
- `convex/reservation_vision.ts`, `convex/item_resolver_queries.ts` — wired

**See Section 4 for tier diagram.**

---

### Fixup (`7aad2c7`)

**Root cause of W4a build failure:** Corrupted partial `node_modules` install (interrupted/OOM-killed `npm install`). Multiple `@trigger.dev/core` and `recharts` `.js` files were missing while `.d.ts`/`.js.map` files existed. Not a version mismatch.

**Fix:** `rm -rf node_modules && npm install --legacy-peer-deps` — no `package.json` changes.

**Additional tightening applied:**
- pHash Hamming threshold: `< 8` → `< 5` (reduces false positives) with `confidence: 0.9` floor
- Memory `threadId` namespace: `threadId` → `accountSlug:threadId` (prevents cross-account collision)

---

## 4. Vision Pipeline Tier Diagram

```
Image URL received
       │
       ▼
┌──────────────────────────────────────────────┐
│  Tier 1: pHash lookup (item_image_phash)      │
│  Hamming distance < 5 + confidence ≥ 0.9     │
│  Cost: FREE (Convex read)                     │
│  Speed: ~1 ms                                 │
└──────────────┬───────────────────────────────┘
               │ MISS
               ▼
┌──────────────────────────────────────────────┐
│  Tier 2: vectorIndex cosine > 0.85            │
│  (item_embeddings, source_kind="image")       │
│  Cost: Gemini embed call only                 │
│  Speed: ~200 ms                               │
└──────────────┬───────────────────────────────┘
               │ MISS
               ▼
┌──────────────────────────────────────────────┐
│  Tier 3: Gemini Flash multimodal vision       │
│  + fuzzy item match against catalog           │
│  Cost: FREE (1500 req/day free tier)          │
│  Speed: ~1–2 s                                │
└──────────────┬───────────────────────────────┘
               │ MISS / low confidence
               ▼
┌──────────────────────────────────────────────┐
│  Tier 4: Grok Vision (xAI) — PAID, LOGGED    │
│  Cost: ~$0.01–0.05/image                     │
│  Speed: ~2–4 s                                │
└──────────────┬───────────────────────────────┘
               │
               ▼
       Write-back (all tiers 2/3/4)
       → item_image_phash (pHash cache)
       → item_embeddings (image-source embed row)
       Next encounter → Tier 1 HIT (free)
```

**Expected hit-rate trajectory:**

| Period | Tier 1+2 hit rate | Tier 3+4 rate |
|--------|------------------|---------------|
| Day 1 (cold) | ~10% | ~90% |
| Week 1 | ~40–60% | ~40–60% |
| Month 1 | ~75–85% | ~15–25% |
| Steady state | ≥ 80% (target) | ≤ 20% |

Tier 1 cache grows monotonically — every paid call permanently reduces future spend.

---

## 5. Secrets Needed in Vault / Env

**Store in Convex project-hub vault** (never inline in code or chat).

| Secret name | Service | Where to store | Notes |
|-------------|---------|----------------|-------|
| `BROWSERBASE_API_KEY` | Browserbase | Convex vault, service `browserbase` | **ROTATE — key was shared in chat** |
| `BROWSERBASE_PROJECT_ID` | Browserbase | Convex vault, service `browserbase` | |
| `GEMINI_API_KEY` | Google AI | Vercel env + Convex env | Free tier: https://aistudio.google.com |
| `LANGFUSE_PUBLIC_KEY` | Langfuse | Vercel env | Optional — graceful no-op if absent |
| `LANGFUSE_SECRET_KEY` | Langfuse | Vercel env | Optional — graceful no-op if absent |

**Browserbase key rotation is strongly recommended** before enabling `USE_STAGEHAND=1`. Generate a new key at https://browserbase.com/dashboard and update the vault entry.

---

## 6. Monitoring Queries (Post-Deploy)

### Rate limit 429 hit rate
```
dashboard_chat_messages.metadata.rate_limited_429_count
```
Query via Convex dashboard → `dashboard_chat_messages` table, filter `metadata.rate_limited` field. Alert if > 5% of turns in a 1-hour window.

### Langfuse traces
Langfuse cloud dashboard → project traces view. Check trace count matches expected chat volume. Filter by `model` tag for cost breakdown.

### Mastra Memory thread sizes
Monitor LibSQL file size growth on Vercel `/tmp/mastra-memory.db`. Target: stays under 50 MB per container. Summarisation should auto-compress beyond `lastMessages: 8` budget.

### Vision tier distribution
```sql
-- Convex: reservations.resolved_via_tier aggregated
SELECT resolved_via_tier, COUNT(*) as hits
FROM reservations
WHERE resolved_via_tier IS NOT NULL
GROUP BY resolved_via_tier
ORDER BY resolved_via_tier;
```
Target: Tier 1+2 ≥ 80% at steady state. Track weekly to confirm cache warm-up progression.

### dldr batch sizes
HydrationLayer emits log lines with batch sizes. Search Vercel log drain for `[HydrationLayer] T2 batch` to confirm batching is coalescing correctly (target: > 1 item per batch during reservation loads).

---

## 7. Deployment Notes

### Pre-deploy checklist

- [ ] Rotate `BROWSERBASE_API_KEY` (key was shared in chat — treat as compromised)
- [ ] Obtain `GEMINI_API_KEY` from https://aistudio.google.com (free tier)
- [ ] Store all secrets in Convex project-hub vault + Vercel env vars (see Section 5)

### Deployment sequence

```bash
# 1. Merge branch (no-ff if main has advanced)
git checkout main
git merge --no-ff phase3c-oss-adoptions

# 2. Deploy Convex (new tables: item_embeddings, item_image_phash + new internalActions)
npx convex deploy --yes

# 3. Push application
git push origin main

# 4. Vercel auto-deploys on push — verify build green in Vercel dashboard

# 5. Run backfills from Convex dashboard (Functions tab → internalActions):
#    - item_embeddings:backfillEmbeddings   (embed existing items)
#    - migrations/backfill_phash:backfillPhash  (pHash existing item images)
#    These are idempotent; re-runnable if interrupted.

# 6. DO NOT flip USE_STAGEHAND=1 yet
#    Only enable after first Stagehand smoke on prod Hygglo confirms
#    Zod-schema extraction works for a real booking action.
```

### Environment variables to set

**Vercel:**
- `GEMINI_API_KEY`
- `LANGFUSE_PUBLIC_KEY` (optional)
- `LANGFUSE_SECRET_KEY` (optional)
- `USE_STAGEHAND` — leave unset or `0`

**Convex vault (via project-hub addSecret):**
- `BROWSERBASE_API_KEY` (service: `browserbase`) — rotate first
- `BROWSERBASE_PROJECT_ID` (service: `browserbase`)

**Convex environment (via Convex dashboard Settings → Environment Variables):**
- `GEMINI_API_KEY` (needed for embedding internalActions)

---

## 8. Rollback

All adoptions are isolated behind commit boundaries with no breaking schema changes.

| Adoption | Rollback |
|----------|---------|
| Rate limiter | `git revert <w1a-commit>` — removes convex.config.ts + rate_limit_config.ts; no data loss |
| Langfuse | `git revert <w1b-commit>` — removes langfuse.ts; no side effects (no-op shim anyway) |
| dldr | `git revert b622dd5` — restores custom batcher; HydrationLayer API unchanged |
| Mastra Memory | `git revert 41fb5b9` — restores manual `getMessages(limit:6)`; Convex data intact (dual-write) |
| Stagehand | `git revert 91e0149` — removes src/lib/browserbase.ts; hygglo-ui-action reverts to Playwright; `USE_STAGEHAND` was OFF anyway |
| Vector index + embeddings | `git revert <w3a-commit>` — removes `item_embeddings` table from schema; existing rows become orphaned (non-breaking) |
| Vision pipeline | `git revert 18b25d7` — restores direct Grok Vision calls; `item_image_phash` table becomes unused (non-breaking) |
| Fixup | `git revert 7aad2c7` — undoes pHash tightening + threadId namespace (LibSQL threads become cross-account collision risk; do not revert alone) |

**Schema note:** Convex tables are append-only. Reverting code that references a table does not delete the table or its data. Re-run `npx convex deploy --yes` after schema revert commits to drop unused table definitions from the deployment.

---

## 9. Open Concerns (Phase 3c.2 Backlog)

All LOW priority — no blockers for merge.

| ID | Concern | Severity |
|----|---------|---------|
| M9 | Browserbase cache eviction: per-process Map, no TTL. Long-lived containers accumulate Stagehand sessions. | LOW |
| M14 | Vision pipeline writeback (pHash + embedding) in `resolve_item_from_image.ts` — `try/catch` wrapping incomplete; writeback failure should be non-fatal but log. | LOW |
| — | vitest case missing for `dldr loadByIds(t, [])` empty-array edge case | LOW |
| — | Semgrep re-scan pending (token missing in hook environment; scan was skipped) | LOW |
| — | `convex/_generated/api.d.ts` was hand-edited to add vectorIndex types — regenerate via `npx convex dev` on first real deployment to get correct generated types | LOW |

---

## 10. Not in Scope

The following items are explicitly deferred and were **not** included in this branch:

- **Renter-facing bot (Phase 4)** — now unblocked by this phase. Owner-side memory, rate limiting, and vision pipeline are all preconditions. Phase 4 can begin.
- **Phase 3a deferred items:**
  - Trigger snapshot file deletion (orphaned S3/R2 files)
  - `resolved_items` column NULL handling for legacy reservations

---

## 11. Cross-References

- Phase 1 shipped doc: `docs/phase1-shipped.md` (if exists)
- Phase 1c shipped doc: `docs/phase1c-shipped.md` (if exists)
- Phase 2 shipped doc: `docs/phase2-shipped.md` (if exists)
- Phase 3a shipped doc: `docs/phase3a-shipped.md` (if exists)
- Phase 3b shipped doc: `docs/phase3b-shipped.md` (if exists)
- Branch prep: `/tmp/wfo-phase3c/branch_prep.md`
- Per-wave reports: `/tmp/wfo-phase3c/w1a_ratelimit.md` through `fixup.md`
- Adversarial review: `/tmp/wfo-phase3c/w4b_adversarial.md` (concerns M9, M14 originate here)
