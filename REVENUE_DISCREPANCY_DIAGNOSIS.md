# Lifetime Revenue vs Active Rentals — Diagnosis (2026-05-14)

## TL;DR
The two widgets do NOT actually compute different net-to-owner totals for Oct 2025–Apr 2026. I verified by running both code paths over the live Convex deployment `hearty-oyster-600` (dev). They yield **identical** per-month NET sums to the penny.

The "discrepancy" Daniel sees is **display-side**, not aggregation-side. Specifically: `getLifetimeByMonth` SUBTRACTS damage/insurance amounts visually via a negative `damageClaims` segment, while Active Rentals widget reports gross net-to-owner with no such deduction. For Oct 2025–Jan 2026 this knocks ~£388/mo off the visible bar.

## Evidence (live data, dedup by hygglo_order_id / v1_rental_id)

| Month   | revenue.ts NET (`dbcinemaOrganic+leoOrganic+danielOrganic+vertusOrganic+aiBoost`) | Active Rentals NET (live∧¬obsolete∧¬cancelled/declined) | Δ NET | `damageClaims` overlay | Bar total shown in chart |
|---------|---|---|------|------|------|
| 2025-10 | 3695.55 | 3695.55 | 0 | **+389** (hist) | 4084.55 |
| 2025-11 | 4610.00 | 4610.00 | 0 | **+388** (hist) | 4998.00 |
| 2025-12 | 2882.56 | 2882.56 | 0 | **+388** (hist) | 3270.56 |
| 2026-01 | 2394.72 | 2394.72 | 0 | **+388** (hist) | 2782.72 |
| 2026-02 | 2084.00 (1566.92 dbc + 517.08 aiBoost) | 2084.00 | 0 | 0 | 2084.00 |
| 2026-03 | 4714.18 (2213.37 dbc + 1331.13 leo + 1169.68 aiBoost) | 4714.18 | 0 | 0 | 4714.18 |
| 2026-04 | 1601.60 (828.27 dbc + 375.94 leo + 397.39 aiBoost) | 1601.60 | 0 | 0 | 1601.60 |

So the per-month NET reservation revenue is **identical** between the two definitions. There is NO status / order_step / pickup-vs-dropoff drift. All rows in Oct-25→Apr-26 are status `completed` (with one `confirmed`), no `pending_review`, no `is_obsolete=true`, no missing `end_date`, no `net_to_owner_gbp == null`, no `hygglo_order_id` collisions.

## So why does the chart "look low"?

Three subtle effects, in priority order:

### 1. `historical_revenue` damage overlay adds **positive** £388/mo for Oct 25 – Jan 25 (`convex/revenue.ts:492, 497, 508`)
Damage costs are loaded from `historical_revenue.damage_costs_gbp` and ADDED as a `damageClaims` segment. The chart series config (`LifetimeRevenue.tsx:38`) renders this segment with `fill: "url(#grad-damage)"` color `#ffffff` (white) which is visually subtle but **inflates** the bar above the actual rental income.

If Daniel reads the bar total as "earned" he is seeing a number ~£388 **higher** than reality for Oct-Jan, not lower. If he reads only the colored (dbcinema/leo/aiBoost) portion, he sees the correct net-to-owner.

### 2. Lifetime "Total Revenue" header (`revenue.ts:608`) **excludes the current month for all-accounts view**
```ts
const completedRows = rows.filter(
  (row) =>
    (accountSlug ? row.month <= currentMonth : row.month < currentMonth) &&
    ...
);
const totalRevenue = r2(completedRows.reduce((s, row) => s + monthRev(row), 0));
```
If Daniel is on the "All accounts" view, today (2026-05-14) the partial-month £2528.80 is excluded from the **header total** even though the May bar is visible on the chart. Per-account view includes it. This is the most likely "missing money" complaint.

### 3. AI Boost split visually moves money OUT of dbcinemaOrganic into aiBoost segment (`revenue.ts:499-503`)
From 2026-02 onward, ~19.4% of dbc + leo revenue is re-coloured as green "AI Boost". The bar **total** is unchanged, but if the legend toggle hides "AI Boost", the bar collapses by 19.4%. Check Daniel's `hidden` toggle state (`LifetimeRevenue.tsx:86`).

## Filter definitions confirmed identical for past months

**Active Rentals widget** (`convex/dashboard.ts:getStatsDrawerData`, predicates `convex/lib/reservations/predicates.ts`):
- `monthBookedRentals` = `!is_obsolete && (status==="confirmed" || status==="completed") && start_date && end_date && effectiveDate in [monthStart, monthEnd]`
- Sums `netOf(r) = r.net_to_owner_gbp ?? 0`
- Dedup: keeps row with MAX net per hygglo_order_id/v1_rental_id/composite

**Lifetime chart past months** (`revenue.ts:402-422`):
- `!is_obsolete && status !== "cancelled" && status !== "declined" && status !== "pending_review" && status !== "pending"`
- Sums `r.net_to_owner_gbp ?? 0`
- Dedup: keeps FIRST seen (no max-on-collision)
- Buckets by `pickup_date ?? start_date` (same `effectiveDate` definition)
- Adds `damageClaims` and reshuffles into aiBoost segment

For Oct-Apr these reduce to the same row set (all rows are `completed`/`confirmed`).

## Real bug (minor, in revenue.ts)

`revenue.ts:407` uses **first-seen** dedup, predicates.ts uses **max-net**. Differs only when same hygglo_order_id has duplicate inserts with different net values — none currently exist in the live DB, but the inconsistency is a latent landmine.

```ts
// revenue.ts (current)
if (seenOrderIds.has(id)) return false;
seenOrderIds.add(id);
// vs predicates.dedupByLogicalRental — keeps max-net row
```

## Recommended action (no code changes yet)

1. **Ask Daniel which number he expected** — header "Total" (all-accounts excludes May), bar height (includes damage overlay), or one specific bar series.
2. If "bar looks low": likely AI Boost or damage toggle hidden. Inspect chart `hidden` state in browser DevTools.
3. If "total looks low for all-accounts view": fix `revenue.ts:608` filter — change `row.month < currentMonth` to `row.month <= currentMonth` to match per-account view, OR display "(excl. current month)" subtitle.
4. Replace `revenue.ts:404-411` dedup with `dedupByLogicalRental` from `convex/lib/reservations/predicates.ts` for consistency.
5. Backfill `historical_revenue.total_overall_made_gbp` for Oct 25 – Jan 26 (currently zero) if the £388/mo damage figure should NOT have been overlaid on otherwise-tracked months.

## Files inspected (all absolute)
- `/home/ubuntu/rental-manager-v2/convex/revenue.ts` (getLifetimeByMonth: lines 287–739)
- `/home/ubuntu/rental-manager-v2/convex/dashboard.ts` (getStatsDrawerData)
- `/home/ubuntu/rental-manager-v2/convex/lib/reservations/predicates.ts` (canonical filters)
- `/home/ubuntu/rental-manager-v2/src/components/dashboard/LifetimeRevenue.tsx` (chart UI, series toggles, ACTUAL_KEYS)
- `/home/ubuntu/rental-manager-v2/src/components/dashboard/stat-cards/ActiveDrawer.tsx` (active drawer UI)
- `/home/ubuntu/rental-manager-v2/convex/historical_revenue.ts` (damage_costs_gbp rows for Oct 25 – Jan 26 only)
