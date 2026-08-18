# Hold resolution — confident design + mapping proposal (2026-08-18)

Follow-up to `inventory-linkage-audit-2026-08-18.md`. Two things changed the
plan, both discovered while preparing to populate `hygglo_product_index`.

---

## 1. The deterministic key already exists — we were reading the wrong array

Reservations carry **two** item arrays:

| Array | `product_id` on live bookings |
|---|---|
| `reservations.items[]` | 0 of 25 |
| `reservations.hygglo_items[]` | **21 of 21** |

`convex/calendar.ts` already keys off `hygglo_items[].product_id`.
`src/lib/reconcile-holds.ts` does not — it uses `items[]`, finds no id, and falls
through to the LLM resolver. **That single array choice is the root cause of the
missing and phantom holds.** No new ingest work is required to fix hold-building;
the key is present on every live line today.

## 2. Do NOT auto-populate the index from existing mappings

`hygglo_products.masterItemId` is wrong often enough that copying it into the
authoritative index would cement the errors. Confirmed wrong on live bookings:

| Listing (currently rented) | Maps to | Should be |
|---|---|---|
| `Sony FX3 Full-Frame Cinema Camera` | Sony A7S III | **Sony FX3** (exists, qty 4) |
| `Sony FX3 Full Frame 4K Cinema Camera Kit \| 24-70` | Sony GM 24-70mm | **bundle**: FX3 + 24-70 |
| `Sony FX3 Camera \| DJI Pro Gimbal / Video Kit` | DJI RS3 Pro gimbal | **bundle**: FX3 + gimbal |
| `Hollyland Pyro S Kit` | Hollyland Mars 4K transmitter | different product line |

A token-overlap suggester is equally unusable — mine returned
`Rode Mic Go Shotgun Microphone` → **"PL to EF mount"** at 1.00 confidence, and
`SmallRig Tripod … Fluid Head` → **"C-stand"** at 1.00, because short master
names such as "C-stand" tokenise to `["stand"]` and match anything containing
that word. This is the *same* failure that produced the original phantom hold.
Fuzzy matching cannot be the resolution mechanism at any confidence threshold.

## 3. Bundles need the other table

Several listings are kits, which a single `product_id → item_id` row cannot
represent. `listing_resolution_override` already exists for exactly this:

```ts
listing_resolution_override: { account_slug, product_id,
  components: [{ item_id, qty }], note, source }
```

So the intended architecture is already in the schema — it is simply unpopulated.

---

## Proposed resolution order (no fuzzy step anywhere)

1. `hygglo_items[].product_id` — always present on live bookings.
2. `listing_resolution_override` → multi-component bundles.
3. `hygglo_product_index` → single-item listings.
4. **Otherwise: create no hold, record the line as UNRESOLVED, surface it in the
   dashboard, and treat the item as unavailable/escalate — never "free".**

Step 4 is what stops the next instance hiding for three months.

---

## Mapping table for Daniel to confirm

Only he can sign these off: they decide whether real gear is double-booked, and
`MASTER_INVENTORY` is locked.

### A. Current mapping is correct — keep (no action)

| pid | Listing | Item |
|---|---|---|
| 1173214 | 3x DJI Osmo Action 5 Pro Kit | DJI Osmo Action Pro 5 (qty 3) |
| 1048267 | Bmpcc 6k full frame blackmagic | BMPCC 6K Full Frame (qty 1) |
| 1173839 | Sony 24-70mm f/2.8 G Master Lens | Sony GM 24-70mm f2.8 (qty 4) |
| 1173562 | Hollyland Mars 4K Wireless Transmitter | Hollyland Mars 4K transmitter |
| 1173815 | HollyLand Pyro 7-inch Wireless Monitor | Hollyland 7-inch monitor |
| 1173826 | Tilta Nucleus Nano II Follow Focus | Tilta Nucleus Nano 2 follow focus |
| 1173463 | SmallRig Tripod / Fluid Head | SmallRig Fluid Head |
| 1173496 | Rode Mic Go Shotgun Microphone | Rode Video Mic Go |

### B. Currently WRONG — needs correcting

| pid | Listing | Currently | Proposed |
|---|---|---|---|
| 1173763 | Sony FX3 Full-Frame Cinema Camera | Sony A7S III | Sony FX3 |
| 1011866 | Sony FX3 digital cinema camera (dbcinema) | *(none)* | Sony FX3 |
| 1173405 | Sony FX3 … Kit \| 24-70 | GM 24-70mm only | **bundle**: Sony FX3 + GM 24-70mm |
| 1173818 | Sony FX3 Camera \| DJI Pro Gimbal | gimbal only | **bundle**: Sony FX3 + DJI RS3 Pro |
| 1173768 | Sony FX3 Full Production Kit | *(none)* | **bundle** — which components? |
| 1173775 | Hollyland Pyro S Kit | Mars 4K transmitter | ? no Pyro S item exists |

### C. Unmapped — need a decision

| pid | Listing | Note |
|---|---|---|
| 1173814 | 3x GoPro Hero 12 Kit + mounts | `GoPro 12 Hero` (qty 3) — bundle w/ mounts? |
| 1173318 | Atomos Ninja V 5" 4K Monitor | `Atomos Ninja V` — looks safe |
| 1173607 | DJI Mic Wireless Kit | `DJI Wireless Mics` — looks safe |
| 1173834 | 4x Sony NP-F970 Batteries | `Sony NPF 970 batteries 2x sets` — 4x vs "2x set" qty semantics? |
| 1173511 | TTArtisan 11mm f/2.8 Fisheye | `Sony 11mm f2.8 fisheye` — same lens under your naming? |
| 1173514 | FXLION Nano Three V-Mount (2x) | no obvious V-mount battery item — does one exist? |

Once A/B/C are confirmed, populating both tables is mechanical, and switching
`reconcile-holds.ts` to `hygglo_items` makes holds deterministic from then on.
