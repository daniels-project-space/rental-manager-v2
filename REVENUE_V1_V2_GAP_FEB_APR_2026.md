# V1↔V2 Revenue Gap — Feb-Apr 2026 (2026-05-14)

## Headline
V2's Feb-Apr 2026 reservations were seeded from the **V1 `rental` table** via the
historical import (`scripts/historical/_archive/import-v1-data.mjs`). That table
stores ONE row per rental with a single-line price; V1's real lifetime number
is `SUM(booking.net_profit) GROUP BY rental_id` across line items.
V2 inherited the under-count plus dropped some rentals entirely via filter
clauses. The Hygglo poller never overwrites these rows (it keys on
`hygglo_order_id`, which is numeric, never the V1 UUID).

## Per-month evidence (validated against V1 `booking` sum, status ∈ confirmed/completed)

| Month | V1 sum | V2 stored | Gap | Rentals MISSING from V2 (£) | Rentals PRESENT but undercounted (£) |
|------:|------:|----------:|----:|----------------------------:|-------------------------------------:|
| 2026-02 | 3272.95 | 2084.00 | 1188.95 | 1 rental → £72.93 | 16 rentals → £1116.02 |
| 2026-03 | 5877.02 | 4714.18 | 1162.84 | 0 in top sample | ~7+ rentals → £1162.84 in top sample (eb0e2dda alone is £1040) |
| 2026-04 | 2069.59 | 1601.60 | 467.99 | 8 rentals → £584.00 | 5 rentals → £284.00 (offsets due to renter_price NULL re-imports) |

Numbers match Daniel's reported gaps (Feb +£1189, Mar +£1163, Apr +£468).

## Top under-counted rentals — V1 `booking.net_profit` SUM vs V2 `net_to_owner_gbp`

| rental_id | V1 sum | V2 stored | Δ | Root cause |
|---|---:|---:|---:|---|
| eb0e2dda-9493-47ef-af4d-255fb3489c26 (Mar) | 2080.00 | 1040.00 | 1040.00 | V1 had 5 line-items (Sony FX3×2 £723 + others); import wrote single `rental.rental_price` |
| bbb3a735-3a1e-4645-b642-58a6f2bb2446 (Feb) | 504.00 | 302.40 | 201.60 | 3 confirmed/completed lines (£302.40 + £100.80 + £100.80) |
| 13a11213…(Mar) | 383.03 | 128.00 | 255.03 | multi-line |
| b88c0300…(Mar) | 522.20 | 298.40 | 223.80 | multi-line (4 anamorphic lenses) |
| c1ae0480…(Mar) | 368.00 | 184.00 | 184.00 | 2 line-items |
| 0110fe92…, 00142063…, 07838456… (Feb) | 192 each | 64/64/96 | 96-128 | multi-camera kits |

## Missing rentals — Apr 2026

| rental_id | V1 sum | V1 `rental.status` | V1 `rental.renter_price` | Why dropped |
|---|---:|---|---|---|
| 6b7e5404-882c-42cc-9730-ee1108cdebf0 | 80.00 | completed | **NULL** | Import filter `renter_price IS NOT NULL` |
| c698ab85-f554-4ba6-9065-59c84219045e | 64.00 | completed | **NULL** | Same |
| 8ca12c2d-f8ef-4413-86d8-011447c50dbd | 80.00 | (likely null) | — | Same |
| cb55827d-7376-416e-9b78-553d8167dd8d | 48.00 | — | — | Same |
| 6e9e8a4a-9887-469f-a609-fe6979a34169 | 36.00 | — | — | Same |
| a7da6819-1bc8-4d54-b1a1-99b4bb1541bd | 40.00 | — | — | Same |
| 37066861-bc75-40e3-9a05-e0622dec5fba | 160.00 | completed | 220.00 | Likely post-import status flip |
| 35d2d9b2-0f09-486f-9863-323ed9de9765 | 76.00 | completed | 116.50 | Same |
| 2aa64e4d…(Feb) | 72.93 | **cancelled** on `rental` (but bookings still completed) | 87.50 | Import filter `r.status IN ('confirmed','completed')` excluded; booking-level acceptance still earned |

## Root causes — code citations

1. **`/home/ubuntu/rental-manager-v2/scripts/historical/_archive/import-v1-data.mjs:178-194`**
   Sources from V1 `rental` table, not `booking`:
   ```sql
   SELECT r.id AS v1_rental_id, r.renter_price, r.rental_price …
   FROM rental r
   WHERE r.status IN ('confirmed', 'completed')
     AND r.renter_price IS NOT NULL
   ```
   Lines `200-213` set `net = r.rental_price`. This is the single headline price,
   not `SUM(booking.net_profit)`.

2. **`scripts/historical/import-missing-orders.mjs:131-134`** — separate bug,
   wrong Hygglo price keys (`detail.price?.totalPrice` / `earningPrice`) vs.
   the correct `detail.price?.breakdown?.totalPrice?.amount` /
   `lenderEarnings?.amount`. Any rentals imported by this script silently got
   `undefined` for gross/net.

3. **`convex/hygglo.ts:484` `upsertOrderAsReservation`** — skips rows that
   already have `v1_rental_id` set (`if (existing.v1_rental_id) return { action: "skipped" }`).
   So even when the live Hygglo poller observed the same order with the correct
   per-order `lenderEarnings`, it refused to overwrite the V1-imported value.
   This guard locks in the under-counted figure forever.

## Patch — backfill script (recommended)

Add `scripts/historical/backfill-net-from-v1-bookings.mjs`:

```sql
SELECT rental_id, SUM(net_profit) AS booking_net_sum,
       SUM(revenue) AS booking_gross_sum
FROM booking
WHERE status IN ('completed','confirmed')
  AND pickup_date >= '2022-08-01'
GROUP BY rental_id;
```

Then per rental_id call a **new** admin mutation
`reservations:adminPatchNetFromV1Booking` that:
- looks up reservation by `v1_rental_id`,
- overwrites `gross_paid_gbp`, `net_to_owner_gbp`, `platform_fee_gbp`
  with the SUM values.

For the MISSING rentals (no V2 row at all), the script should INSERT a fresh
reservation row using `v1_rental_id` as key, copying date/status/account
from V1's `rental` table and items from `extracteditem` (mirroring the
existing import flow but using booking-sum nets).

## Code patch — prevent re-occurrence

In `convex/hygglo.ts:484`, the `if (existing.v1_rental_id) return skipped`
guard needs an exception: if `existing.net_to_owner_gbp < args.net_to_owner_gbp`
and the row has `gross_paid_gbp` close to args, take the bigger number.
Better fix: remove the guard outright once backfill is complete — the
live poller IS the source of truth for any order Hygglo still surfaces.

## Open question
Mar 2026's gap (£1163) is dominated by `eb0e2dda` (£1040). After backfill,
~£123 will remain across smaller rentals — drop into the same booking-sum
patch.
