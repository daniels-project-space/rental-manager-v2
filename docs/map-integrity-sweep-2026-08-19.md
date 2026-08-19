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

## Durable diagnostics

`convex/investigate_integrity.ts` and `convex/investigate_overrides.ts` hold
these checks and are safe to re-run at any time (read-only queries).
