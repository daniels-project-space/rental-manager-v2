# Listing→inventory map integrity sweep — 2026-08-19

Follow-on to `inventory-linkage-audit-2026-08-18.md` and
`widget-consistency-audit-2026-08-18.md`. Daniel: *"Look for any more remaining
inconsistencies."*

## Method

Two mechanical, non-heuristic tests over all 252 `listing_resolution_override`
rows — no similarity scoring, which is banned from writing here after it
re-proposed gear Daniel had just said he doesn't own.

- **A. Impossible demand** — the override asks for more units of an item than
  master inventory has. Cannot be right under any interpretation.
- **B. Zero token overlap** — no component's canonical name shares a meaningful
  word with the listing title.

Plus a tightened version of the earlier double-mapping check: a listing present
in *both* map tables is only a defect when the override does **not** contain the
index item. A superset (override = index item + kit parts) is fine and strictly
more complete. That alone cut the reported conflicts from 26 to 8.

## Root cause

`listing_resolution_override` rows are not equally trustworthy. By provenance:

| source | rows | verdict |
|---|---|---|
| `manual_audit` | 160 | trustworthy |
| **`auto:desc`** | **77** | **systematically unreliable** |
| vision-verified | 5 | trustworthy |
| `auto:marketing` | 4 | trustworthy |

Both defect tests fired almost exclusively on `auto:desc` — the same failure
class as the LLM matcher that produced the phantom C-stand hold. Because the
override table *wins over everything else*, a wrong row here is a silent wrong
answer system-wide.

Worked examples, all `auto:desc`:

| Listing | Held | Should hold |
|---|---|---|
| 2x RGB LED Light Panels | 2x Anker Power Station (qty 1) | LED light panels RGB ×2 |
| 3x RGB LED Light Panels | 3x Anker Power Station (qty 1) | LED light panels RGB ×3 |
| Ambitful 2x RGB Light Tubes | 2x Anker Power Station (qty 1) | Ambitful RGB light tubes 2x set |
| 2x SmallRig Softbox 85cm | 2x SmallRig Fluid Head (qty 1) | Softbox 85cm ×2 |
| 2x smallrig tripod set | 2x SmallRig Fluid Head (qty 1) | Small rig tripod ×2 |
| Teleprompter Kit | DJ RX3 Pioneer controller | nothing (not owned) |
| Aputure 300d/600d light set | DJI RS3 Pro gimbal | nothing (marketing-only) |
| Dji mic wireless + 2x lav | Audio boom mic Sennheiser | DJI Mic 2 wireless |

Every one blocked the *wrong* real gear while leaving the listed gear bookable.

## Two structural exposures (code, not data)

A dead index row is only harmless while every consumer checks the override
first. Two did not:

- **`convex/sync_dbcinema_web.ts`** built its product→item map from
  `hygglo_product_index` alone. DB Cinema *website* bookings therefore resolved
  `DJI Avata 2 → DJI Mavic 3 Pro` and `camera flash → Sony A7 II`.
  Now resolves override-then-index, expands multi-component overrides with
  per-component quantities, and counts deliberately-empty mappings as
  `marketing_units` rather than silently dropping them.
- **`convex/renter_bot_tools.ts`** used the index as its "owned listings" set,
  so the renter bot treated audit-ruled marketing-only gear as ownable and would
  quote it — a DANIEL RULE 18 violation reachable by a renter. Now derives
  ownership from index ∪ non-empty override, with an empty override removing the
  listing from quotable stock.

## Daniel's rulings, applied

- DJI RS3 Pro gimbal: *"the gimbal is the same and there is only 2"* — the
  case-differing duplicate row `DJI RS3 Pro Gimbal` (qty 1) had zero holds,
  index, override and bundle references; its single `masterItemId` link was
  repointed and the row deleted. `DJI RS3 Pro gimbal` (qty 2) is now the only
  row, matching the real count.
- RØDE Wireless PRO: *"we have 2x 2 in stock"* — the listing's "4x" counts
  microphones, not sets → `Rode Wireless Mic Pro set ×2`.
- MACKIE Thump Go: *"we dont have at all"* → item set to qty 0 / marketing-only,
  listing holds nothing.
- Smoke Ninja: *"we have one and then one would be the ninja pro smoke"* →
  `Smoke Ninja ×1 + Smoke Ninja Pro hazer ×1`.
- RODE NTG 5 boom set and RED Komodo listings: *"all marketing"* → hold nothing.

Also corrected: the camera-flash listing had been recorded as "no item →
marketing", but `Camera flash` (qty 1) **does** exist in master inventory. It
now holds that item, and its index row (which pointed at a Sony A7 II body) was
deleted.

## Result

| Check | Before | After |
|---|---|---|
| Impossible demand | 8 | **0** |
| Zero token overlap | 5 | 1 |
| True contradictions | 26 → 8 | **1** |
| Oversold / stale holds / dangling refs / marketing held | 0 | 0 |

The one remaining contradiction is benign: `leo#1112133`, where the index names
the boom mic and the override correctly expands it to the full kit.

## Still open — needs Daniel

- **`leo#1112142`** "Pro Boom Mic Kit + DJI Wireless Mics (2x)" holds the boom
  mic, recorder and card but **not** the DJI wireless mics. `DJI Wireless Mics`
  is qty 1 and the listing advertises 2x, so it cannot be satisfied as written.
- **`Audio boom mic Sennheiser` (qty 2) vs `Sennheiser MKE 600` (qty 1)** — same
  duplicate-naming class as the gimbal. If these are the same physical mic under
  two names, availability is being split across two rows.
- **The other ~64 `auto:desc` rows** passed both mechanical tests but are
  unverified, not proven correct. They were generated the same way as the eight
  confirmed-broken ones. Options: audit all against listing titles, restrict to
  rows with real booking history, or surface them in the dashboard alert when
  rented.

## Pass 2 — full `auto:desc` review (all 66 remaining rows)

Reviewed every remaining `auto:desc` override against its listing title. 48 were
correct. The failure mode is name-token contamination: the generator attached
whichever item name matched an incidental word in the listing text —
**Anker Power Station** for "power", **DJ RX3** for "DJ", **C-stand** for
"stand", **SmallRig Fluid Head** for "fluid".

29 corrections applied:

- **10 contamination strips** — e.g. the Hollyland Mars kit also held a SmallRig
  Fluid Head; the JBL Partybox held a C-stand; the fog machines held the DJ
  controller; the projector held both an Anker and the DJ controller.
- **4 quantity corrections** where the title states "Nx" and the override held
  1x (3× and 2× Sony 24-70 GM, 2x RØDE Wireless PRO, 2× JBL).
- **2 tripod listings** that held the qty-1 SmallRig Fluid Head instead of a
  tripod, matching the earlier `dbcinema#1000760` fix.
- **13 marketing rulings from Daniel** — Blackmagic Pyxis (×2), DJI Mini 5 Pro,
  7.5mm fisheye, DJI RS2, Fujifilm X100VI, Zoom F6, RØDE Wireless GO II,
  Aputure Amaran, Pioneer XDJ-RX2 (×2 listings), DZOFilm 6-lens set, Tilta matte
  box, plus the two remaining RED Komodo sets. All now hold nothing.

Result: `auto:desc` rows 77 → 37, `manual_audit` 160 → 200, impossible demand
holds at **0**.

## Unrelated deploy blocker fixed

Commit `9ad01c4` (Hygglo response-rate alert) added a `low_response_rate` event
type without adding it to `PushNotificationType`, which failed Convex
typechecking and blocked **all** deploys. Added to the union.

Note for whoever owns that feature: `subscriptionReceivesNotification()` passes
only `booking_confirmed` through to `money_only` subscribers, and
`telegramNotificationMode()` defaults to `money_only` — so this URGENT alert is
currently suppressed on Daniel's Telegram fallback unless it is added to that
allowlist. Left as-is rather than changing another feature's routing semantics.

## 2026-08-20 — live Diogo order, same C-stand bug reproduced

The `qty_drift_alerts` dashboard banner ("N bookings with an unmatched
listing") had exactly one open row, and it was real: order `4096440`
(Diogo account, Caylamina Roberts), gear physically out (`order_step:
DELIVERED`), due back 2026-09-11. None of its 4 listings had ever been
mapped, so it resolved via the old LLM fallback and reproduced the exact
original bug:

| Listing | Was resolved to | Fixed to |
|---|---|---|
| Nanlite Forza 300 LED Light Kit | dropped entirely | `Nanlite Forza 300` ×1 |
| Nanlite FC 500B Bi-Color 550W | dropped entirely | `Nanlite 500B` ×1 |
| 3x Heavy Duty Tripod Kit + Fluid Head | **C-stand ×1** | `Small rig tripod` ×3 |
| Smallrig 85cm Soft Box, 2x Set | Softbox 85cm ×2 (already correct) | unchanged |

Added the 4 override rows (`account_slug: "diogo"`), then rewrote this one
reservation's `calendar_holds` (6 wrong rows deleted, 12 correct ones
inserted) and its `resolved_items`/`expanded_items`. The stale
`qty_drift_alerts` row was marked `resolved` — see the structural note below
for why that needed a direct patch rather than an automated re-check.

### Structural finding: resolving a listing later doesn't retroactively fix reservations already resolved

`item_resolver.ts:resolveReservation` checks `resolution_input_hash` —
computed only from the raw listing titles — **before** it ever reaches the
deterministic product_id tier. Adding or fixing an override after a
reservation has already been resolved once therefore has no effect on that
reservation; the hash still matches and it returns `skipped: "fresh"`
without rechecking.

This means every correction applied earlier in this sweep (the 18 + 29
override fixes) may leave `resolved_items`/`expanded_items` stale on any
reservation that was resolved via the LLM fallback *before* its listing's
override existed. `calendar_holds` doesn't have this problem — it's
recomputed fresh from the override/index tables on every poll cycle, not
cached — so holds and the calendar are correct going forward; only the
Active Rentals / overbooking-widget side (which reads `expanded_items`) can
still show stale data for past bookings that were never revisited.

Not fixed structurally here — doing so is a separate decision (either skip
the freshness check when the deterministic tier would apply, or key it off
override-table state too) and doesn't change data correctness going forward
for anything resolved after this session's fixes landed. Flagged for
Daniel's call.

Separately confirmed: `qty_drift_alerts` has no automated close path. Its
own docstring (`audit_qty_drift.ts`) references a "Layer C backfill
(`admin_backfill_qty_resolution`)" that was never actually built — the
function doesn't exist anywhere in the repo. "Manually resolved" is the
real, only mechanism today.

## Sony 28-70mm — not a mapping bug, a real live overbooking

Checked: one master-inventory row, qty 2, correctly pooled by the conflict
detector (which groups by canonical `item_id`, not by listing — confirmed by
reading `convex/dashboard.ts`'s conflict-building loop). The detector is
behaving exactly as intended (only flags at 3+ concurrent, matching "should
not double-book until rented 3x").

The live `conflicts` array from `getStatsDrawerData` shows a genuine active
conflict: **3 confirmed reservations overlapping 2026-08-20 against 2
physical units**, across two different accounts — Tade Abdullahi (leo,
order 4205995), Jamie Hunt (diogo, order 4209227, ends 2026-08-20), Samuel
Castaneto (diogo, order 4211390, ends 2026-08-22). This needs an operational
decision (who gets the lens), not a data fix.

## Renter bot — live-tested via the real pipeline

Ran `renter_bot_probe` (synthetic `__probe__` threads, no send capability,
swept after) against the real `generateDraft` action, three identical
pricing questions on the dbcinema account:

- **Sony FX3** (real stock) → confidently quoted, `usedTools: true`,
  `confidence: 1`.
- **Camera flash** (this session's override fix) → confidently quoted
  correctly, same as FX3.
- **RED Komodo** (marketing-only per Daniel's ruling) → refused to quote a
  price or confirm stock, escalated instead of fabricating.

Same account, same phrasing — the only variable was the underlying mapping,
confirming the `renter_bot_tools.ts` ownership fix is live and correct
end-to-end, not just in the resolver layer.

## 2026-08-20 — the Sony 28-70mm "conflict" was itself a bug

Daniel: *"its rented only twice today you can see that in the calendar too,
investigate where this wrong notion comes from and fix it."* He was right —
the reported 3-way conflict was wrong, not the underlying gear.

Traced `expandedIdsOf()` in `convex/dashboard.ts`, the function the conflict
detector uses. It does **not** read a reservation's stored `expanded_items`
— it re-derives item mapping live, per Hygglo listing position, through its
own priority order: audit override → **a third resolution table,
`listing_info_pool`, not covered by any earlier pass this session** →
`hygglo_product_index` → LLM `resolved_items` with a name-sanity check. Two
of the three "conflicting" reservations were wrong at this layer:

- **`diogo#1173818`** ("Sony FX3 Camera | DJI Pro Gimbal / Video Kit") had an
  existing override bundling `[Sony FX3, DJI RS3 Pro gimbal, **Sony
  28-70mm**]` — a lens the listing title never mentions. Source of this row
  predates this session. Fixed to `[Sony FX3, DJI RS3 Pro gimbal]`.
- **`diogo#1173821`** ("Sony 70-200mm f4 OSS II Lens") had no override or
  index row, fell through to the LLM, which resolved it to Sony 28-70mm —
  wrong lens entirely, and master inventory has no 70-200mm f4 OSS to begin
  with (only the GM 70-200mm f2.8). Added an empty override, same RULE 18
  pattern as every other not-owned listing this session, pending Daniel's
  confirmation he doesn't separately own this lens.

Result: live conflict count for this item **1 → 0** (only the genuine leo
booking remains, well under qty 2). Verified immediately, no caching lag —
unlike `item_resolver.ts`'s stored `resolved_items` (see the diogo-order
finding above), `expandedIdsOf()` reads the override/index tables fresh on
every call, so a fix here takes effect instantly with no force-resolve step
needed.

### Gap in this session's own earlier audit

The `diogo#1173818` contamination is a pattern the "zero token overlap"
check (`investigate_overrides.ts`) cannot catch: 2 of its 3 components
(FX3, gimbal) genuinely matched the title, so `anyHit` was true and the row
never surfaced. Only a *fully* unrelated override gets flagged today; a
mostly-correct one with one smuggled-in extra component does not. Not swept
systemically — flagged as a possible follow-up, not executed unprompted.

### Architecture note: a third "expanded items" computation

Beyond the two systems already documented above (holds via
`reconcile-holds.ts`, `resolved_items`/`expanded_items` via
`item_resolver.ts`), `dashboard.ts`'s conflict/untracked/sell-reco detectors
use a **third**, independent live computation (`expandedIdsOf`) with its own
tier order and its own extra data source (`listing_info_pool`, currently
feature-flagged off for every account). All three should agree once mapping
tables are correct, but they are three separate code paths, not one shared
function.

## Durable diagnostics

`convex/investigate_integrity.ts` and `convex/investigate_overrides.ts` hold
these checks and are safe to re-run at any time (read-only queries).
