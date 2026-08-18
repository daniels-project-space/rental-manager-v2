# Inventory linkage audit — 2026-08-18

Triggered by Daniel spotting that the C-stand was not in the 9–11 Sept order.
Working assumption, per his framing: **if a logic error like that reaches a
renter, assume the system does not work until each link is proven.**

Everything below is measured against the live `hearty-oyster-600` deployment,
not inferred.

---

## 1. The deterministic key is dead (root cause)

`reservations.items[].product_id` is the only field that can tie an order line
to a specific Hygglo listing, and through it to a master inventory item.

| Metric | Value |
|---|---|
| Order lines ever recorded | 2,710 |
| Lines carrying `product_id` | **2** |
| Lines carrying `slug` | **2** |
| Newest line with either | **2026-05-19** |

`shape.ts` maps it correctly:

```ts
product_id: typeof i.productId === "number" ? i.productId : undefined,
```

The pipeline is typed for it end to end (schema → `shape.ts` → poller payload
type). Two rows prove Hygglo *does* supply it. It stopped ~2026-05-20 — the same
date the schema comment says the poller "starts writing these" — and the
`typeof === "number"` guard turns the absence into `undefined` **silently**, with
no error, no counter, no alert. It has been dead for roughly three months.

**Consequence chain:** no id on the line → `reconcile-holds.ts` falls back to the
LLM resolver's `expanded_items` → resolver drops/mis-maps lines → no calendar
hold → `items.qty` is never consulted → a qty=1 item that is physically rented
still reports `free_whole_horizon: true`.

## 2. Half the catalogue has no link at all

Across 1,165 rows in `hygglo_products`:

| Link quality | Count | % |
|---|---|---|
| **Unlinked (no `masterItemId`)** | 569 | **49%** |
| Linked, `matchScore` ≤ 1 | 359 | 31% |
| Linked, `matchScore` ≤ 2 | 199 | 17% |
| Linked, `matchScore` > 2 | **38** | **3%** |

Renting an unlinked listing holds *nothing*. Only 3% of the catalogue is linked
with meaningful confidence.

## 3. The links that do exist are frequently wrong

26 linked rows share <50% of the master item's own name tokens. Reviewing them
by hand (my metric produces some false positives — e.g. `Cannon 24-105 Ef f4` →
`Canon EF 24-105mm f4` is correct, flagged only on a tokenising artefact), the
genuinely wrong ones include:

| Listing (what gets rented) | Mapped to | Why it's wrong |
|---|---|---|
| `Cannon c 70 cinema camera + 1TB sd card` | **128GB V30 SD card** | A ~£3k cinema body is invisible to availability; only the card is held |
| `2x Go Pro Hero 12 set + 4x batteries + 2x 128gb sd card` | **128GB V30 SD card** | Both cameras invisible |
| `Party DJ Speakers PA + Lights laser gigbar` | **DJ RX3 Pioneer controller** | Speakers/lights → a controller |
| `Cannon 15-35 mm f2.8 rf zoom lens` | **Canon EF 16-35mm f2.8** | Different mount *and* focal range |
| `2x Chauvet Gigbar 2 DJ Light` | **Ambitful RGB light tubes 2x set** | Unrelated product |
| `4x Godox TL60 Tube Lights` | **Ambitful RGB light tubes 2x set** | Different brand and quantity |
| `Rode wireless go 2 + 2x Lav mics` | **Rode Video Mic Go** | Wireless lav kit → on-camera shotgun |
| `Monitor 7 inch Atomos Shinobi` | **SmallHD Cine 7 Monitor** | Different brand/model |
| `3x Heavy Duty Camera Tripod Kit … Cinema Tripod **Stand**` | **C-stand** | The one Daniel caught — token overlap on "stand" |

Each wrong link is two bugs at once: the real item is never held (double-booking
risk) and an innocent item is falsely blocked (lost bookings).

## 4. Measured live impact

- 6 of 15 live/future confirmed bookings have unheld items.
- 7 rented items currently read as available, including **Tilta Nucleus Nano II
  (out right now)**, **Sony FX3 (19 Aug)**, **3x DJI Osmo Action 5 Pro**,
  **BMPCC 6K Full Frame**, **3x GoPro Hero 12**, **2x Nanlite lights**.
- Most are `qty: 1` — rented means unavailable, no ambiguity.
- One false hold: C-stand blocked on dates it was never rented.

---

## Correction to an earlier claim

I previously reported "availability grounding verified correct". That was wrong
in an important way. The bot faithfully reports what the database says, but the
database's holds are incomplete and partly incorrect, so its availability
answers are wrong for a large part of the catalogue. My test happened to pick
the one item that *had* a (mistaken) hold rather than any of the items missing
holds.

---

## Fix: resolve with confidence, no fallback guessing

The design principle Daniel asked for — resolve properly so a fallback is not
needed, and never let an unresolved line pass silently.

1. **Restore `product_id` capture at ingest.** This is the only truly
   deterministic key. Needs a live `/v4/my/orders/{id}` payload inspection (vault
   creds) to confirm the field's current shape, then fix the mapper and backfill
   historical reservations from order detail.
2. **Make the mapping explicit and reviewed, not fuzzy.**
   `hygglo_product_index` already exists in the schema as "the deterministic
   product_id → item_id override", with a bootstrap in
   `convex/admin_bootstrap_pidindex.ts`. Populate it as the authoritative map;
   fuzzy `matchScore` becomes a *suggestion* for operator review, never a
   silent write.
3. **Fail loud.** An order line that resolves to no item must be recorded and
   surfaced in the dashboard, and must block/escalate — never fall through to an
   LLM guess for something that decrements real stock.
4. **Availability must fail closed.** An item whose linkage is unknown should
   read "unconfirmed — escalate", not "free".
5. **Repair current state**: add the 7 missing holds, drop the C-stand false
   hold, and re-review the ~9 wrong links above.

Steps 1–2 are the real fix; 3–4 are what stop the next instance hiding for three
months.
