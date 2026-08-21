# Renter-bot quality rework — 2026-08-21

Daniel reviewed a 3-turn Lab conversation and listed six defects. The existing
test suite scored it "flag" and named none of them. This is the root-cause pass
plus the testing rework that makes that class of miss impossible.

## The transcript

Scenario: **BMPCC 6K Pro**, marked *"Free for these dates"*, seed £35/day.

Every reply opened with *"That exact BMPCC 6K Pro isn't available"*. It offered
a BMPCC 6K Full Frame it had invented kit for, answered a lens question with a
Sony body, and priced an early collection as an extra day with no offer.

## Root causes

### 1. `owned` was a fail-dangerous boolean → false unavailability

`get_listing_context` defaulted `owned = false` and only reached `true` if ALL
of: `account_slug` present → `product_id` is a number → a `hygglo_products` row
exists → it has a `masterItemId` → that item is active.

Any gap produced `owned: false`. The most common gap is *an inquiry line with no
`product_id`* — i.e. **every fresh inquiry and every Lab scenario**. The draft
route then emitted:

> we CANNOT rent this ... Frame it ONLY as not available for their dates

So the bot told renters that real, in-stock, completely free gear was
unavailable. Verified live: `getItemAvailabilityForChat` returned
`free_today: true, owned: true, is_marketing_only: false, upcoming_bookings: []`
for the exact item it was declining.

`kind` was `null` on the same path, so the route's `if (it.kind)` guard skipped
fetching alternatives entirely — meaning **the substitute it named was pure
invention**, as was the kit list.

**Fix:** ownership is tri-state (`true` / `false` / `null`), with a name-based
fallback resolution against master inventory. Only an explicit `false` may drive
the concealment path.

### 2. Matchers threw away the tokens that distinguish two products

- `find_owned_alternatives` had **`"pro"`, `"full"`, `"frame"`** in its stopword
  list, so `BMPCC 6K Pro` and `BMPCC 6K Full Frame` both reduced to
  `{bmpcc, 6k}` — literally indistinguishable.
- `lookup_pricing` scored raw **coverage** (hits ÷ query tokens) against long
  marketing listing names. `"BMPCC 6K Pro"` scored a **perfect 1.0** against
  *"Blackmagic cinema camera full frame 6k Bmpcc + Rode video mic **pro** plus
  microphone + tripod smallrig interview set"* — the `"pro"` came from the
  **microphone**. Wrong body, wrong kit, £70 for a £35 item.

**Fix:** new `convex/lib/item_name_match.ts` — Jaccard over variant-preserving
tokens (coverage rewards a long name for accidental hits; Jaccard penalises the
extra tokens the query never asked for). Underspecified queries (`"BMPCC 6K"`,
which fully matches *both* bodies) report ambiguous rather than silently
picking one. Pricing resolves by identity via the `product_id` index.

### 3. Listing titles are SEO-poisoned and cannot identify anything

The real BMPCC 6K Full Frame listing is titled
*"... (EF Mount, RAW, ProRes, Dual Native ISO) **Bmpcc 6k pro** camera cinema"* —
it contains the rival body's full name. Any title-similarity lookup returns the
wrong body's kit. All kit resolution is now identity-only.

### 4. Alternatives were ranked by nothing useful

`find_owned_alternatives(kind:"camera")` returned Sony bodies first for a
Blackmagic request and **included the requested item in its own alternatives
list**. Now ranked by substitutability (same category → same lens mount →
shared family tokens), carrying real kit and an `includes_lens` flag.

### 5. `kind` taxonomy drift silently produced ZERO alternatives

RED Komodo's kind is **`camera_body`**; every rentable camera is **`camera`**.
So `by_kind("camera_body")` returned only marketing rows, filtered them all out
as not-owned, and returned an **empty list**. With no alternative to name, the
draft had no grounding at all → `UNGROUNDED_AVAILABILITY` +
`UNGROUNDED_PRICE` (both critical) → **100% of not-owned inquiries escalated to
Daniel**, so the "conceal the reason, offer an alternative" rule never once
reached a renter.

Found only after making the escalation **return its flags** instead of
escalating silently — worth keeping for its own sake.

**Fix:** normalise kind for comparison; if a kind-scoped query yields zero owned
rows, fall back to the whole catalog and let substitution ranking pick; resolve
the substitution target against the FULL catalog (the item being replaced is
usually the one we *don't* stock, so looking it up in the owned set lost its
kind and mount).

### 6. Two tools disagreed about price — a money bug

`find_owned_alternatives` picked the **cheapest** listing sharing ≥0.6 of the
name tokens; `lookup_pricing` resolved by identity. One live conversation
offered the Sony FX3 at **"£18/day"** in turn 2 and **"£112 for 4 days"**
(= £40/day, the real price) in turn 5. Every substitution was under-priced.
Both now resolve by identity, with the same curated `pricing_catalog` fallback.

### 7. The model invented kit even when told not to

With `whats_included: null` and an explicit "do NOT invent contents"
instruction, the bot still said a body *"comes with batteries, charger, and
SSD"*. A prompt instruction is not enforcement, so this is now a mechanical
`KIT_HALLUCINATION` guard (critical ⇒ escalates) fed by a real
`itemsWithoutKitData` signal.

## The testing rework

The old rubric scores **one draft** against regex/tone filters. None of the six
defects are visible in one draft: repetition, ignoring the question and
brand-jumping are cross-turn, and false unavailability / invented kit are only
detectable against **ground truth**.

`convex/lib/renter_bot_conversation_rubric.ts` scores a whole CONVERSATION
against ground truth:

| check | catches |
|---|---|
| `false_unavailability` | said unavailable while the calendar says free |
| `cross_turn_repetition` | a sentence recycled from an earlier reply (0.5 Jaccard — the live repeat scored 0.550 with one parenthetical bolted on) |
| `question_answered` | reply opens by restating availability instead of answering |
| `substitution_sanity` | brand/system jump while a same-family option existed |
| `kit_hallucination` | kit claimed for an item we hold no kit data on, incl. anaphora ("the camera body ... it comes with") |
| `day_count_negotiation` | early-collection ask priced but never negotiated |
| `lens_follow_through` | "no lens" with no concrete offer to add one |
| `price_consistency` | two different daily rates across turns |

Its test feeds **Daniel's real transcript in verbatim** and asserts every defect
is caught, plus a corrected transcript that must pass.

`scripts/renter-bot-conversation-test.mjs` drives real 5-turn conversations
through the live pipeline, re-seeding full history each turn so the agent can
see what it already said. Probe threads only (`__probe__`, excluded from the
Reply Inbox, swept after) — it never touches a send path.

### The suite caught bugs in itself

Iterating found three false positives and one false negative in my own checks:
`"Hi!"` counted as a sentence and pushed the real answer out of the "opening"
window; `kit_hallucination` fired on the *negation* "no lens included";
`lens_follow_through` was satisfied by a *different camera's* bundled lens; and
`"does that price include a lens?"` was scored as a price question. A noisy
rubric gets ignored, so each was tightened.

## Before / after (same 5-turn conversation, live pipeline)

Before — every turn opened identically, kit invented, no negotiation.

After:

> **is this available tomorrow?** → "Yes, the BMPCC 6K Pro is available tomorrow. Pickup is between 10am to 12pm or 7pm to 9pm..."
>
> **does that price include a lens?** → "It's body only, but I can add a Canon EF 24-105mm f4 for £20/day if you need a lens to go with it."
>
> **can i pickup the day before and return the day after?** → "...you can also collect the evening before (7-9pm) and return the evening of your shoot (7-9pm)." — explains the day count *and* offers the single-day framing.

Not-owned path (RED Komodo), previously 100% escalation:

> "The Blackmagic cameras are body-only, so you would use your own EF glass with the 6K Pro or L-mount lenses with the Full Frame. If you need a complete kit with glass included, the Sony FX3 comes with the 24-70mm GM lens."

## Still open — data, not code

- **`BMPCC 6K Pro` has ZERO listing mappings on any account.** It genuinely has
  no price or kit data, so the honest answer is limited. Same inventory-linkage
  family as the sweep in `map-integrity-sweep-2026-08-19.md`. Needs a mapping.
- **`kind` values are inconsistent** (`camera_body` vs `camera`). The code is
  now resilient to it, but the catalog should be normalised.
- Turn 1 of a not-owned conversation still escalates occasionally where turns
  2-5 draft correctly — worth a look if it persists.
