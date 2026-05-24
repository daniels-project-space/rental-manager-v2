# Listing Info Pool — backfill samples (2026-05-24)

Phase 2 result snapshot after running `backfillActive` against the 60-day
active-rental surface (56 candidates; +3 churn during the run = 59 derived).

## Summary

| Metric | Count |
|---|---|
| Pool rows total | 59 |
| `derivation_method = text` | 58 |
| `derivation_method = passthrough_fallback` | 1 |
| `needs_review = true` | 18 |
| `derivation_confidence >= 0.9` | 31 |
| `derivation_confidence 0.7-0.9` | 5 |
| `derivation_confidence 0.4-0.7` | 15 |
| `derivation_confidence < 0.4` | 2 |
| Vision-fallback runs | 0 (see Limitations) |

## FX3 bundle-collision fix (the original bug)

Olivia's two FX3 tiles on dbcinema confirmed distinct under the new
display_name:

| product_id | Old short_name | New display_name | components (resolved) |
|---|---|---|---|
| 948607 | Sony FX3 Cinema Camera | **Sony FX3** | Sony FX3 ×1 |
| 1011153 | Sony FX3 Cinema Camera | **Sony FX3 + Sony GM 24-70mm f2.8** | Sony FX3 ×1, Sony GM 24-70mm f2.8 ×1 |
| 1011859 | (no short_name) | **Sony FX3 + Sony GM 24-70mm f2.8 + Atomos Ninja V** | Sony FX3 ×1, GM 24-70mm ×1, Atomos Ninja V ×1 |

Leo's FX3 surface (cross-account equivalence):

| product_id | display_name | canonical_bundle_signature (suffix) |
|---|---|---|
| 1097499 | 3x Sony FX3 | `Sony FX3 ×3` (needs_review: plus_token_unparsed for "with cards & batteries") |
| 1097510 | Sony FX3 | `Sony FX3 ×1` |
| 1097513 | Sony FX3 + Sony GM 70-200mm f2.8 | FX3 + GM 70-200 ×1 |
| 1116309 | 2x Sony FX3 | `Sony FX3 ×2` |
| 1122292 | 2x Sony FX3 + Sony GM 24-70mm f2.8 | FX3 ×2 + GM 24-70 ×1 |
| 1122295 | Sony FX3 + Sony GM 24-70mm f2.8 | FX3 ×1 + GM 24-70 ×1 |
| 1122297 | (Phase 2 — Atomos variant) | FX3 + GM 24-70 + Atomos |

The canonical_bundle_signature on Olivia's tiles now differs:

- 948607 → `items|<FX3_id>x1`
- 1011153 → `items|<GM2470_id>x1|<FX3_id>x1`
- 1011859 → `items|<Atomos_id>x1|<GM2470_id>x1|<FX3_id>x1`

→ double-booking / out-of-stock (Phase 3) will hold each component
separately, not merge them into a single "Sony FX3" bucket.

## Cross-section examples

### dbcinema#1048266 — 2x FX3 + 2x lens + 2x tripod kit
```
raw     : 2x Sony fx3 fx 3 full frame camera + 2x tripods small + 2x Sony 24-70 mm zoom lens f2.8 gmaster g-master gm
display : 2x Sony FX3 + Sony GM 24-70mm f2.8
components:
  - primary           qty=2 conf=0.95  Sony FX3                span="Sony fx3 fx 3 full frame camera"
  - bundled_required  qty=2 conf=0.9   Sony GM 24-70mm f2.8    span="2x Sony 24-70 mm zoom lens f2.8 gmaster g-master gm"
  - standard_included qty=2 conf=0.7   Small rig tripod        span="2x tripods small"
```

### dbcinema#1048267 — BMPCC bundle
```
raw     : Bmpcc 6k full frame ... + cannon 24-105mm lens ... + tripod ...
display : BMPCC 6K Full Frame + Canon EF 24-105mm f4
components:
  - primary           qty=1 conf=0.95  BMPCC 6K Full Frame
  - bundled_required  qty=1 conf=0.9   Canon EF 24-105mm f4
  - standard_included qty=1 conf=0.7   Small rig tripod
```

### dbcinema#936035 — partial resolution (review-flagged)
```
raw     : Sony a7ii + DJI wireless mic kit ... + Sony FE zoom lens 28-70mm
display : Sony A7 II + DJI wireless mic kit microph.. + Sony 28-70mm
needs_review: true
review_reasons: [unresolved_canonical:DJI Wireless Mics]
```
DJI wireless mic isn't in the items master, so item_id is null — flagged
for human resolution. Display still surfaces the bundle suffix using the
LLM's source phrase as a fallback label.

### dbcinema#966791 — clean single-item listing
```
raw     : Sony 90mm f2.8 macro lens
display : Sony 90mm f2.8 macro
primary : Sony GM 90mm f2.8 (confidence 0.95)
```

## needs_review breakdown

The 18 needs_review rows fall into three buckets:

1. **`plus_token_unparsed`** (3 rows) — title has `+` / `with` after the
   primary but only 1 component survived validation. Safety guard fires;
   display name is still correct. Examples: leo/1097499 (`with cards &
   batteries` mention), leo/1116309 (`SONY A7S3 LEVEL` comparison-like
   token already in comparison_references but title-level "+" delimiters
   confuse parser).
2. **`unresolved_canonical`** (12 rows) — LLM emitted a valid
   source_span but the canonical-name fuzzy-match scored below 0.45.
   These are usually accessories not in the items master (DJI lapel
   mics, generic cleaning kits) or model variants under aliases not yet
   added (e.g. "Sony 28-70mm" should alias to a master row). Display
   gracefully falls back to the source phrase.
3. **`no_components`** (1 row, passthrough_fallback) — LLM couldn't quote
   a single verbatim phrase. Stored as passthrough so we don't keep
   re-trying every poll.

All three buckets are safe by design: the worst case is that an
overridden / unresolved row uses the source phrase as a display label
and contributes nothing to bundle-equivalence. Existing
`listing_short_names` path remains the fallback while Phase 3 flag is
OFF.

## Limitations / follow-up

### No vision fallback this pass
The plan called for a vision pass when text-only confidence < 0.7 OR
plus_token_unparsed fires. rental-manager-v2 currently does not have a
hooked-up vision model: the `reservation_vision_backfill.ts` action is
just a side-table mirror, and `convex/lib/imageResolution.ts` does
phash/hint lookup only — no LLM vision call. Phase 2 ran text-only.

To add later: wire either Gemini Flash or grok-vision via OpenRouter,
download image bytes (or pass URL if the provider supports it), prompt
"list every physical item visible on the table in this product photo —
quote each as a noun phrase". Run only when text-only path emitted
`needs_review = true`. Estimated cost ≤ $0.20 for a full 60-day
re-pass.

### Active set churn
Run start: 56 candidates. End: 59 rows. The poller added 3 new active
listings during the backfill — they got picked up automatically because
backfillActive re-reads the candidate list per call.

### Items-master gaps
12 of 18 needs_review rows are unresolvable accessories. Suggest a one-
time pass through `listing_info_pool:listNeedsReview` and either (a)
add missing items rows / aliases, or (b) accept that those listings
attribute revenue under "primary only" (which the legacy path also does).

### Convex-vs-Trigger placement
CLAUDE.md at the repo root mandates "no new Convex action that calls
generateObject/generateText — LLM-heavy work belongs on Trigger.dev".
The Phase 1-2 derivation lives in `convex/listing_info_pool_actions.ts`
per the explicit task spec. If/when this is hot-pathed by the poller
(Phase 5), consider migrating the per-call derivation to a Trigger
schedules.task to keep Convex action billing flat.

## Cost estimate

DeepSeek-v4-flash via OpenRouter:
- ~1500 input tokens × 50 derivations × $0.112/M = $0.0084
- ~250 output tokens × 50 × $0.224/M = $0.0028
- **Total Phase 2 backfill: ≈ $0.011** (≪ the $0.06 estimate in the plan)

Some retries against Alibaba's rate-limit added a few duplicate calls,
maximum cost ≈ $0.02. Negligible.
