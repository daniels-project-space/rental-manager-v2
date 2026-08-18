# Widget / availability consistency audit — 2026-08-18

Daniel: *"ensure the rest of the Rental Manager is also concurrent with that
including the overbooking widget, item listing availability in the calendar, and
every single other widget."*

Answer: **it is not, and fixing calendar_holds alone does not fix it.** There are
two parallel resolution systems, keyed differently, feeding different consumers.

---

## The two systems

| | System A — holds | System B — expanded_items |
|---|---|---|
| Key | `hygglo_items[].product_id` | listing **title hash** |
| Map tables | `listing_resolution_override`, `hygglo_product_index` (both `account+product_id`) | title-hash override via `listing_cache.lookupOverride`, else **LLM** |
| Written by | `reconcile-holds.ts` → `calendar_holds` | `item_resolver.ts` → `reservations.expanded_items` |
| Consumers | Calendar Gantt, `mv/calendar`, `capacity_gap`, renter-bot availability | **Overbooking widget, Active Rentals, calendar availability** |
| Status | **FIXED** 2026-08-18 (deterministic, fails loud) | **STILL LLM-DRIVEN** |

`convex/lib/availability.ts:130` states it outright:

> Booked units — from CONFIRMED reservations' expanded_items (the Active
> Rentals / **overbooking** / calendar-availability source of truth).

`bookedUnitsOnDate()` (line 63-74) reads
`r.expanded_items ?? r.resolved_items` and never touches `calendar_holds`. So the
overbooking widget and calendar availability inherit **exactly** the resolver
faults that produced the C-stand phantom hold and the two unheld Nanlite lights
— independently of the hold fix.

`isItemUnitAvailable()` does respect quantity correctly
(`totalUnits = items.qty`, minus booked, minus repair-held), so the arithmetic
is sound. The input is what is wrong.

## What this means concretely

A `qty: 1` item that is genuinely rented shows as available in the overbooking
widget whenever the resolver dropped it — the exact class of error Daniel caught
on the 9–11 Sept booking. Conversely a mis-resolved item (tripod → C-stand)
makes the widget report the wrong gear as busy.

## Recommended fix (not yet implemented — needs sign-off)

Make `item_resolver.ts` resolve by `product_id` FIRST, using the same
`listing_resolution_override` / `hygglo_product_index` tables that now drive
holds, before its title-hash override and before any LLM call. Then both systems
share one deterministic source and every downstream widget becomes correct at
once. Keep the loud-unresolved behaviour: an order line with no mapping must
surface, not silently resolve to nothing.

Until that lands, holds are trustworthy and the overbooking widget is not.

---

## dbcinema listing audit (405 listings)

Automated brand / model / category cross-check, comparison text
("like Rode NTG") stripped to avoid false flags.

- 238 linked, **167 unlinked**, **25 flagged** as brand/model/category mismatches.

### Fixed (correct item existed, listing unambiguous)

| Listing | Was | Now |
|---|---|---|
| `2x Nanlite pavotube 30x ii` | Ambitful RGB tubes | **Nanlite Pavotube 30x II ×2** |
| `4x Nanlite pavotube 30x ii` | Ambitful RGB tubes | **Nanlite Pavotube 30x II ×4** |
| `Dji mic wireless + 2x lav` | Rode Video Mic Go | **DJI Mic 2 wireless** |

### Systemic pattern found — listings for gear NOT in master inventory

`fx30`, `a6600`, `R5 C`, `RS2`, `12-24mm`, `15-35mm`, `35mm f1.4`, Meike, Godox
have **no master-inventory item at all**, yet each listing was force-mapped onto
a different real item (e.g. `Sony 12-24mm GM` → `Sony GM 24-70mm`,
`Cannon 15-35 RF` → `Canon EF 16-35`, `DJI RS4/RS2` → `DJI RS3 Pro`). Per
DANIEL RULE 18 — *"ANY item not on master list = not in stock"* — these must hold
nothing. Left unmapped deliberately: they now surface as UNRESOLVED instead of
silently blocking real gear.

### Needs Daniel's call

- Does he own an RS2 / RS4 / R5 C / FX30 / a6600 / 12-24mm / 15-35mm / 35mm f1.4?
  If yes they are missing from MASTER_INVENTORY; if no, the listings are
  marketing-only and should be flagged as such.
- `Meike Cine Lens Set (Like DZO Vespid)` → currently maps to the real DZOFilm
  Vespid set. If the Meike set is a *separate* product this is double-blocking
  the Vespids; if it is marketing-only it should hold nothing.
- Bundle listings still mapped to a single component: `Sony fx6 + 24-70`,
  `2x Sony FX3 + 2x 24-70`, `Budget interview setup 3x GoPro`,
  `2x GoPro Hero 12 set` (→ currently the SD card).
- `V-mount 150mAh` item name — the FXLION label reads **150Wh**. Wrong unit.
