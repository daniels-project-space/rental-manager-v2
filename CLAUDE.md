# rental-manager-v2 — routing rules for future changes

This file tells Claude (and humans) where new code belongs. The patterns
below were established in the 2026-05-15 cost audit (commits 516c2fe →
903d889) which dropped Convex bandwidth ~98% and removed all LLM
runtime from Convex action billing. Future changes that ignore these
patterns will silently drag costs back up.

The companion script `scripts/check-patterns.mjs` enforces a subset of
this — run `npm run check:patterns` (and CI runs it on every PR).

---

## Where new things live

| Use case | Goes here | NOT here |
|---|---|---|
| LLM-driven background batch (resolver / extractor / canonicaliser) | `src/trigger/<name>.ts` as a `schedules.task` | Convex `action` with `cron.interval` |
| Live reactive query for a dashboard widget | Convex `query()` with `.withIndex(...)` | Convex `query()` with `.collect()` |
| Aggregate cached for chat / dashboard tooltip | Convex MV in `convex/mv/` (refresher cron) | Recomputing on every read |
| Lifetime / immutable / append-only data ≥ 1k rows | R2 (`src/lib/r2-cold-storage.ts`) + Convex MV index of pointers | Hot Convex table |
| Per-chat-turn context bundle | In-process cache in the API route (60s+ TTL) | Fresh Convex query per turn |
| Hygglo poller / scrapers | `src/trigger/poll-hygglo.ts` | Convex action |
| Anything reading from Convex from server code | `src/lib/convex.ts` (hardcoded URL) or `src/mastra/data/client.ts` | `process.env.NEXT_PUBLIC_CONVEX_URL` (Vercel pins it to the wrong deployment) |
| Cold storage of v1 / archival data | R2 with aggregate indexes (see `src/trigger/export-v1-to-r2.ts`) | Keep on Convex |
| Schema-less / large blob output (screenshots, JSON exports) | R2 (`src/lib/hygglo-ui-r2.ts` for write helper) | Convex storage |

## Hard rules (CI enforces)

1. **No `ctx.db.query("reservations").collect()` without `.withIndex(...)`.**
   Reservations table is 1700+ rows. Full scans cost real money.
   Use `by_start_date` for date-range, `by_v1_rental_id` for migration
   lookups, `by_account_slug` for account scoping, `_creationTime` desc
   for "newest N" via `.order("desc").take(N)`.

2. **No new Convex `internalAction` or `action` that calls `generateObject` /
   `generateText`.** LLM-heavy work belongs on Trigger.dev (template:
   `src/trigger/canonicalize-denials.ts`). Convex action runtime is
   billed; Trigger compute is free-tier.

3. **No `process.env.NEXT_PUBLIC_CONVEX_URL` in `src/mastra/` or
   `src/app/api/`.** Vercel pins it to a stale deployment
   (`exciting-lion-29`); the live deployment is `hearty-oyster-600`. Use
   the hardcoded URL pattern from `src/mastra/data/client.ts` or
   `src/lib/convex.ts`.

4. **Cron cadences floor at 5 minutes.** Anything more frequent should
   be a webhook or a reactive subscription, not a cron.

5. **Trigger.dev tasks must include a `maxDuration` cap.** Otherwise
   stuck LLM calls bill until the platform timeout (5 min default
   inherited). Pick something realistic for the workload.

## Soft rules (lint warning, not error)

6. New chat tools should add 60s in-process cache if called per-turn.
7. New Convex queries that filter by date should use the date index.
8. New denial / event-style writes should accept R2 path as future home
   (don't bake in Convex-only assumptions).

## Patterns to copy

| Want this | Copy from |
|---|---|
| New scheduled LLM batch | `src/trigger/canonicalize-denials.ts` |
| New scheduled vision batch | `src/trigger/vision-resolve.ts` |
| New scheduled chat-extractor | `src/trigger/extract-booking-times.ts` |
| New MV-backed query | `convex/mv/top_earners.ts` (refresher) + `convex/intel.ts` (reader) |
| New R2 writer | `src/lib/r2-cold-storage.ts` (helper) + `src/trigger/export-v1-to-r2.ts` (caller) |
| New chat tool with cache | `src/app/api/chat/route.ts` (`getCachedBundle`) |
| Indexed reservations read | `convex/mv/top_earners.ts` (`withIndex("by_start_date", ...)`) |

## Convex deployment URLs

- **Canonical (poller writes, dashboard reads, chat reads)**:
  `https://hearty-oyster-600.convex.cloud`
- **DO NOT WRITE TO**: `https://exciting-lion-29.convex.cloud`
  (Vercel's default `NEXT_PUBLIC_CONVEX_URL` — orphan deployment, kept
  only because Vercel won't let us remove it).

## Cost-watch checklist (when adding any new cron)

- [ ] Cadence is the slowest that gives acceptable freshness
- [ ] Reads use indexes (no `.collect()` on >100-row tables)
- [ ] Writes are batched (one mutation per cron run, not per row)
- [ ] LLM calls are on Trigger.dev, not Convex actions
- [ ] If aggregating, output goes to an MV table or R2 — not recomputed on read
