# Phase 4 — Deterministic Listing Resolver SHIPPED

## TL;DR
Replaced the 4-tier AI vision pipeline (pHash + Gemini vision) with a v1-inherited
7-tier deterministic cascade resolver. Vision tables (`item_image_phash`,
`item_embeddings`) plus their `vectorIndex` were dropped. Net: **+3924 / -2813**
LOC, simpler hot path, deterministic match provenance, inline pending-review chat.

## Commit Chain (`main..HEAD`)
```
fcb9f88 feat(resolver): port v1 item_matcher + inventory_categories + photo_reference + listing_resolution schema
358bce7 feat(resolver): port v1 6-tier cascade orchestrator + Tier 7 pending_review queue
1b0b3d2 feat(audit): one-shot audit_listings internalAction (idempotent + chunked + cursor paginated)
3191a44 feat(router): query_pending_listings + mutate.label_listing for inline Daniel review
3d8ceda feat(poll-hygglo): call new listing_resolver instead of vision pipeline
8be29e5 feat(vision): DELETE 4-tier vision pipeline + item_image_phash/item_embeddings tables + jimp/@google/generative-ai deps
ffc37cb fixup(phase4): unify topN scoring (H1+H2), add account filter to labelListingFromReview (M7)
```

## 7-Tier Cascade (resolver source-of-truth)

```
Tier 1  CATALOG       hygglo_id direct hit                conf 1.00
Tier 2  PHOTO_REF     photo_reference table snapshot      conf 0.95
Tier 3  PATTERN       title/desc regex from item_aliases  conf 0.90
Tier 4  DETAIL_API    hygglo listing-detail authoritative conf 0.85
Tier 5  AI            LLM classifier (last-resort heur.)  conf 0.70
Tier 6  FUZZY         token-set + jaro-winkler topN       conf 0.55
Tier 7  PENDING_REVIEW queued for Daniel inline review    conf  —
```

Source: `convex/listing_resolver/cascade.ts` (orchestrator) +
`convex/listing_resolver/item_matcher.ts` (T3/T6).

## v1 Inheritance Credits

| v2 path | v1 origin (file:line) |
|---|---|
| `convex/listing_resolver/item_matcher.ts` | `legacy/rental-manager/src/services/itemMatcher.ts:1-340` |
| `convex/listing_resolver/inventory_categories.ts` | `legacy/rental-manager/src/services/inventoryCategories.ts:1-180` |
| `convex/listing_resolver/photo_reference.ts` | `legacy/rental-manager/src/services/photoReference.ts:1-260` |
| `convex/listing_resolver/cascade.ts` (T1-T6) | `legacy/rental-manager/src/services/listingResolver.ts:50-410` |
| Tier 7 pending_review | NEW in v2 (no v1 equivalent — v1 just dropped) |

## LOC Delta (per W5a audit)
- Added: 3924 lines (resolver + audit + chat + schema)
- Removed: 2813 lines (vision-resolve.ts, pHash worker, embedding generator, jimp/gemini deps)
- Net: +1111 LOC, but **conceptual complexity sharply down** (no AI inference in hot path).

## Schema Migration Notes (ONE-WAY)
Dropped:
- `item_image_phash` (table + all rows)
- `item_embeddings` (table + rows + `byEmbedding` **vectorIndex**)

Convex vector indexes cannot be recreated identically without re-ingestion,
so **take a `npx convex export --prod` before deploy** (this runbook does).
Rollback path requires re-creating empty tables and re-running v1 pHash worker
against historical images — costly and not auto-scripted.

## Monitoring Queries

Source distribution (run via Convex dashboard or `convex run`):
```ts
// listing_resolutions grouped by source
await ctx.db.query("listing_resolutions")
  .filter(q => q.gte(q.field("_creationTime"), Date.now() - 24*3600*1000))
  .collect()
  .then(rows => rows.reduce((acc, r) => {
    acc[r.source] = (acc[r.source]||0) + 1; return acc;
  }, {}));
// expect keys: catalog | photo_ref | pattern | detail_api | ai | fuzzy | manual
```

Pending review backlog:
```ts
await ctx.db.query("listing_resolutions")
  .withIndex("byStatus", q => q.eq("status", "pending_review"))
  .collect().then(r => r.length);
```

## Post-Deploy Commands

1. Trigger audit cold-start (one-shot, idempotent):
   ```
   npx convex run --prod audit_listings:runAudit '{}'
   ```
2. Daniel reviews pending listings inline via chat:
   ```
   "review pending listings"
   ```
   Router exposes `query_pending_listings` + `mutate.label_listing`
   (account-filtered per M7).

## Rollback
1. `git revert ffc37cb 8be29e5 3d8ceda 3191a44 1b0b3d2 358bce7 fcb9f88` (in order).
2. `npx convex deploy` — schema returns but tables come back **empty**.
3. Restore data from `/tmp/convex_export_pre_phase4_*.zip` if needed
   (`npx convex import --prod --replace <zip>`).
4. Re-run v1 pHash/embedding workers to re-ingest images (slow — hours).

## Known Follow-Ups (Deferred)
- **M5** — batch action for audit cold-start (currently single internalAction; large account backlogs may need chunked dispatch).
- **M6** — `totalSkipped` counter in audit return shape (currently only resolved/pending/errors).
- **reservation_vision side-table** — orphan rows left behind by vision deletion; cleanup migration deferred to a follow-up wave.

## Cross-Links
- [phase1-shipped](./phase1-shipped.md) — Convex bootstrap
- [phase1c-shipped](./phase1c-shipped.md) — R2 snapshot writers
- [phase2-shipped](./phase2-shipped.md) — vault + provenance
- [phase3a-shipped](./phase3a-shipped.md) — Mastra router scaffold
- [phase3b-shipped](./phase3b-shipped.md) — chat surface
- [phase3c-shipped](./phase3c-shipped.md) — telegram bridge
