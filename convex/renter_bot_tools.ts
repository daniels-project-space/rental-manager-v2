/**
 * Convex queries that back the Mastra renter-bot tools (5 of the 7 — the
 * other two are `search` (in convex/knowledge.ts) and `getTemplate`
 * (also in convex/knowledge.ts)).
 *
 * All queries here are READ-ONLY by Convex's `query()` constraint —
 * the runtime will reject any `ctx.db.insert/patch/delete` call.
 *
 * Index discipline (per CLAUDE.md hard rule #1): no `.collect()` on
 * `reservations` without a `withIndex(...)`. The bot only ever scans
 * `reservations` filtered by `by_account_slug` or `by_hygglo_order_id`.
 */
import { query, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { stageFromReservationStatus } from "./lib/renter_bot_intents";
import { computeNegotiationStance } from "./lib/renter_bot_negotiation";
import { sameMount, bestMatch, rankByName, substitutionScore } from "./lib/item_name_match";

// ── Tool 1: get_renter_context ───────────────────────────────

export const get_renter_context = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();

    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();

    let renter: { _id: string; display_name?: string; hygglo_rating?: number; total_rentals_count?: number; total_spend_gbp?: number; blacklisted?: boolean; blacklist?: boolean; blacklist_reason?: string; renter_dna?: unknown } | null = null;
    if (conversation?.renter_id) {
      const r = await ctx.db.get(conversation.renter_id);
      if (r) {
        renter = {
          _id: String(r._id),
          display_name: r.display_name,
          hygglo_rating: r.hygglo_rating,
          total_rentals_count: r.total_rentals_count,
          total_spend_gbp: r.total_spend_gbp,
          blacklisted: r.blacklisted ?? r.blacklist,
          blacklist_reason: r.blacklist_reason,
          renter_dna: r.renter_dna,
        };
      }
    } else if (reservation?.renter_name) {
      // Fallback by display name when conversation.renter_id is missing.
      const r = await ctx.db
        .query("renters")
        .withIndex("by_display_name", (q) =>
          q.eq("display_name", reservation.renter_name?.trim() ?? ""),
        )
        .first();
      if (r) {
        renter = {
          _id: String(r._id),
          display_name: r.display_name,
          hygglo_rating: r.hygglo_rating,
          total_rentals_count: r.total_rentals_count,
          total_spend_gbp: r.total_spend_gbp,
          blacklisted: r.blacklisted ?? r.blacklist,
          blacklist_reason: r.blacklist_reason,
          renter_dna: r.renter_dna,
        };
      }
    }

    // 12, not 3 (2026-08-21). The CONVERSATION_CRAFT anti-repetition rule says
    // "look at the conversation so far — if you have already told this renter
    // an item is unavailable, or already given the pickup windows, do NOT
    // restate it". With a 3-message window that rule was structurally
    // UNENFORCEABLE past a turn or two: by turn 4-5 the earlier statement had
    // scrolled out of view, so the model restated it and the route's
    // "already said it" check could not see it either.
    //
    // Measured on the not_owned_graceful scenario: turn 5 re-opened with "The
    // RED Komodo isn't available for those dates" when asked about PRICE.
    // 12 covers a 5-6 turn exchange (renter + owner per turn) and is cheap —
    // chat messages are short, and the static prefix is cached separately.
    const recentMsgs = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .take(12);

    const stage =
      conversation?.conversation_stage ??
      stageFromReservationStatus(reservation?.status, reservation?.order_step);

    return {
      thread_id,
      account_slug:
        conversation?.account_id
          ? (await ctx.db.get(conversation.account_id))?.slug ?? "unknown"
          : reservation?.account_slug ?? "unknown",
      hygglo_order_id: reservation?.hygglo_order_id ?? thread_id,
      renter,
      conversation_stage: stage,
      last_messages: recentMsgs
        .map((m) => ({
          sender: m.sender === "owner" ? "owner" : "renter",
          sender_name: m.sender_name ?? m.sender,
          body: m.body_text,
          at: m.hygglo_sent_at ?? m.fetched_at,
        }))
        .reverse(),
    };
  },
});

// ── Tool 2: get_listing_context ──────────────────────────────

export const get_listing_context = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    const account_slug =
      (reservation?.account_slug ?? null) ||
      ((conv as { account_slug?: string } | null)?.account_slug ?? null);

    // The items actually being requested, WITH their product_id — from the
    // reservation (authoritative once booked) or the inquiry (before that).
    type Line = { name: string; qty: number; product_id: number | null };
    let lines: Line[] = [];
    if (reservation?.hygglo_items?.length) {
      lines = reservation.hygglo_items.map((h) => ({
        name: h.name,
        qty: h.qty ?? 1,
        product_id: (h as { product_id?: number }).product_id ?? null,
      }));
    } else if ((conv as { inquiry_items?: unknown[] } | null)?.inquiry_items?.length) {
      lines = ((conv as { inquiry_items: Array<{ name?: string; qty?: number; product_id?: number }> }).inquiry_items).map((it) => ({
        name: it.name ?? "",
        qty: it.qty ?? 1,
        product_id: it.product_id ?? null,
      }));
    } else if (reservation?.items?.length) {
      lines = reservation.items.map((i) => ({ name: i.item_name, qty: i.qty ?? 1, product_id: null }));
    }

    // Enrich each REQUESTED item with its REAL per-account Hygglo listing:
    // the daily price + the description (= what is IN the set). Keyed by
    // product_id, so no name-guessing. This is the ground truth for what the
    // renter is actually asking about.
    const items: Array<Record<string, unknown>> = [];
    for (const l of lines) {
      let daily_price_gbp: number | null = null;
      let whats_included: string | null = null;
      let listing_name: string | null = null;
      let public_url: string | null = null;
      // OWNERSHIP IS TRI-STATE (2026-08-21). Previously this was a bare
      // boolean defaulting to false, so "we could not determine ownership"
      // was indistinguishable from "we verified we do NOT own it".
      //
      // That default was fail-DANGEROUS. Reaching `owned: true` required all
      // of: account_slug present -> product_id is a number -> a hygglo_products
      // row exists -> it has a masterItemId -> that item is active. Any gap
      // (most commonly: an inquiry line with no product_id, which is every
      // fresh inquiry and every Lab scenario) silently produced owned:false.
      // The draft route then told the agent "we CANNOT rent this, frame it
      // ONLY as not available" — so the bot confidently told renters that
      // real, in-stock, completely free gear was unavailable, and invented a
      // substitute because kind was null too. Live-reproduced on BMPCC 6K Pro.
      //
      // null = UNKNOWN. Only an explicit false may drive the concealment path.
      let owned: boolean | null = null;
      let kind: string | null = null;
      let ownership_source: string = "unresolved";
      // The body's mount, so we can offer glass that actually fits even when
      // the listing carries no "what's included" text. Knowing a body is
      // EF-mount is enough to answer "does it come with a lens?" usefully
      // ("body only, I can add the Canon EF 24-105 for £X") instead of
      // stalling with "let me check".
      let lens_mount: string | null = null;
      // When the renter's wording matches SEVERAL real products (e.g. "BMPCC
      // 6K" fully describes both the 6K Pro and the 6K Full Frame), the bot
      // must ASK which. Detected already by bestMatch's confidence gate, but
      // previously discarded — so the agent answered "yes I have the BMPCC 6K"
      // and then invented a third product line with fabricated specs to
      // explain the difference. Surface the candidates instead.
      let ambiguous_with: Array<{ name: string; lens_mount: string | null; kind: string | null }> = [];
      if (account_slug && typeof l.product_id === "number") {
        const prod = await ctx.db
          .query("hygglo_products")
          .withIndex("by_account_product", (q) =>
            q.eq("accountSlug", account_slug).eq("productId", l.product_id as number),
          )
          .first();
        const mid = (prod as { masterItemId?: unknown } | null)?.masterItemId;
        if (mid) {
          const it = await ctx.db.get(mid as never);
          if (it) {
            kind = (it as { kind?: string }).kind ?? null;
            owned =
              (it as { status?: string }).status === "active" &&
              !(it as { is_marketing_only?: boolean }).is_marketing_only;
            ownership_source = "product_id";
          }
        }
      }

      // FALLBACK: no product_id (fresh inquiry / Lab scenario) or the listing
      // carried no masterItemId. Resolve the line by NAME against master
      // inventory instead of giving up. Ambiguous names stay UNKNOWN rather
      // than guessing a body the renter never specified.
      if (owned === null) {
        const allItems = await ctx.db.query("items").collect();
        const m = bestMatch(
          l.name,
          allItems,
          (i) => i.name_canonical,
          (i) => (i.aliases ?? []) as string[],
        );
        if (m.match && m.confident) {
          const it = m.match;
          kind = kind ?? (it.kind ?? null);
          lens_mount = (it as { lens_mount?: string | null }).lens_mount ?? null;
          owned = it.status === "active" && !it.is_marketing_only && (it.qty ?? 0) > 0;
          ownership_source = "name_match";
          // Pull the real kit + price for THIS item via the deterministic
          // product_id index, so an alternative/inquiry line still gets true
          // "what's included" text instead of the agent inventing one.
          if (account_slug && (daily_price_gbp === null || whats_included === null)) {
            const idxRows = await ctx.db
              .query("hygglo_product_index")
              .withIndex("by_item_id", (q) => q.eq("item_id", it._id))
              .collect();
            // An item often has SEVERAL listings — a bare body and bundles
            // built around it. Take the CHEAPEST, i.e. its base offering,
            // exactly as lookup_pricing does.
            //
            // This previously took the FIRST index row, so the two tools
            // disagreed about the same item: lookup_pricing said the Sony FX3
            // was £40/day (bare body) while this handed the agent £60/day
            // (the body + 24-70mm bundle). Quoting the bundle as "the FX3"
            // overstates the base rate, and whichever tool the agent happened
            // to use decided the number the renter saw.
            const pids = idxRows
              .filter((r) => r.account_slug === account_slug)
              .map((r) => r.product_id);
            let bestListing: { daily_price?: number; description?: string; name?: string; public_url?: string } | null = null;
            for (const pid of pids) {
              const listing = await ctx.db
                .query("online_listings")
                .withIndex("by_account_product", (q) =>
                  q.eq("account_slug", account_slug).eq("product_id", pid),
                )
                .first();
              if (!listing) continue;
              const p = listing.daily_price;
              const bp = bestListing?.daily_price;
              if (!bestListing || (typeof p === "number" && (typeof bp !== "number" || p < bp))) {
                bestListing = listing;
              }
            }
            if (bestListing) {
              daily_price_gbp = daily_price_gbp ?? bestListing.daily_price ?? null;
              whats_included = whats_included ?? bestListing.description ?? null;
              listing_name = listing_name ?? bestListing.name ?? null;
              public_url = public_url ?? bestListing.public_url ?? null;
            }
          }
        } else if (m.match && m.ambiguousWith.length > 0) {
          ownership_source = "ambiguous_name";
          // Carry each candidate's REAL mount/kind. Telling them apart by
          // mount is a fact we hold and is exactly what the renter needs
          // ("which one takes EF glass?"); withholding it just to avoid
          // inventing specs made the bot useless and escalate instead.
          ambiguous_with = [m.match, ...m.ambiguousWith].map((i) => ({
            name: i.name_canonical,
            lens_mount: (i as { lens_mount?: string | null }).lens_mount ?? null,
            kind: i.kind ?? null,
          }));
        }
      }
      if (account_slug && typeof l.product_id === "number") {
        const listing = await ctx.db
          .query("online_listings")
          .withIndex("by_account_product", (q) =>
            q.eq("account_slug", account_slug).eq("product_id", l.product_id as number),
          )
          .first();
        if (listing) {
          daily_price_gbp = listing.daily_price ?? null;
          whats_included = listing.description ?? null;
          listing_name = listing.name ?? null;
          public_url = listing.public_url ?? null;
        }
      }
      items.push({
        name: l.name,
        qty: l.qty,
        product_id: l.product_id,
        // true = verified owned; false = verified NOT rentable; null = UNKNOWN.
        // Consumers MUST treat null as "not verified" and never as "not owned".
        owned,
        ownership_source,
        kind,
        lens_mount,
        ambiguous_with,
        listing_name,
        daily_price_gbp,
        whats_included,
        public_url,
      });
    }

    return {
      thread_id,
      found: items.length > 0,
      is_inquiry: !reservation,
      account_slug,
      items,
      // The request itself: dates, pickup/return time, what they pay, location.
      start_date: reservation?.start_date ?? null,
      end_date: reservation?.end_date ?? null,
      pickup_time: reservation?.pickup_time ?? null,
      return_time: reservation?.return_time ?? null,
      gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
      pickup_method: (reservation as { pickup_method?: string } | null)?.pickup_method ?? null,
      location: (reservation as { location?: unknown } | null)?.location ?? null,
      order_step: reservation?.order_step ?? null,
      status: reservation?.status ?? null,
      // A booking is only CONFIRMED (safe to call "booked") in these states.
      is_confirmed: ["confirmed", "ongoing", "completed"].includes(
        (reservation?.status as string | undefined) ?? "",
      ),
      awaiting_owner_action: (reservation as { awaiting_owner_action?: boolean } | null)?.awaiting_owner_action ?? null,
    };
  },
});

// ── Tool 3: lookup_pricing ───────────────────────────────────

export const lookup_pricing = query({
  args: {
    item_name: v.string(),
    account_slug: v.optional(v.string()),
    days: v.optional(v.number()),
    listing_location_non_central: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { item_name, account_slug, days = 1, listing_location_non_central },
  ) => {
    // GROUND TRUTH first: the account's REAL Hygglo listing (its actual
    // daily price + description/kit), matched by name against OWNED-backed
    // listings. Falls back to the curated pricing_catalog below. (Daniel)
    if (account_slug) {
      const STOP = new Set(["the","and","for","with","plus","set","kit","bundle","combo"]);
      const toks = (str: string) =>
        Array.from(new Set((str.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
          (t) => (t.length > 1 || /^[0-9]$/.test(t)) && !STOP.has(t))));
      // "Owned" = the index, CORRECTED by the audit-authoritative override.
      // The index alone let the bot quote gear the audit had already ruled
      // marketing-only (DANIEL RULE 18: not on the master list = not in stock),
      // and hid gear whose only correct mapping lives in an override.
      const [idxRows, ovrRows] = await Promise.all([
        ctx.db.query("hygglo_product_index").collect(),
        ctx.db
          .query("listing_resolution_override")
          .withIndex("by_account_product", (q) => q.eq("account_slug", account_slug))
          .collect(),
      ]);
      const ownedPids = new Set<number>();
      for (const r of idxRows) if (r.account_slug === account_slug) ownedPids.add(r.product_id);
      for (const o of ovrRows) {
        // Empty components = deliberately backed by nothing → never quotable.
        if (o.components.length === 0) ownedPids.delete(o.product_id);
        else ownedPids.add(o.product_id);
      }
      const listings = (await ctx.db.query("online_listings")
        .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
        .collect()).filter((l) => ownedPids.has(l.product_id));
      // DETERMINISTIC FIRST (2026-08-21): resolve the item by name against
      // master inventory, then find ITS listing via the audit-authoritative
      // product_id index. Identity, not string similarity.
      //
      // The old path scored raw COVERAGE (hits / query-token-count) over long
      // marketing listing names, which is how "BMPCC 6K Pro" scored a PERFECT
      // 1.0 against "Blackmagic cinema camera full frame 6k Bmpcc + Rode video
      // mic PRO plus microphone + tripod smallrig interview set": the "pro"
      // came from the MICROPHONE. It returned the wrong body, the wrong kit,
      // and £70/day for a £35/day camera. Coverage cannot distinguish "this
      // listing IS the item" from "this listing merely mentions the item".
      let best: (typeof listings)[number] | null = null;
      let bestScore = 0;
      {
        const allItems = await ctx.db.query("items").collect();
        const im = bestMatch(
          item_name,
          allItems,
          (i) => i.name_canonical,
          (i) => (i.aliases ?? []) as string[],
        );
        if (im.match && im.confident) {
          const idxRows = await ctx.db
            .query("hygglo_product_index")
            .withIndex("by_item_id", (q2) => q2.eq("item_id", im.match!._id))
            .collect();
          const pids = new Set(
            idxRows.filter((r) => r.account_slug === account_slug).map((r) => r.product_id),
          );
          // Overrides are audit-authoritative and are where hand-mapped
          // listings land, so identity resolution must read BOTH tables.
          // Reading only the index meant a listing mapped via an override was
          // invisible here: the 2026-08-22 Blackmagic body mappings resolved
          // correctly for holds and get_listing_context but not for pricing,
          // which silently fell back to the curated catalog.
          const ovrForItem = await ctx.db
            .query("listing_resolution_override")
            .withIndex("by_account_product", (q2) => q2.eq("account_slug", account_slug))
            .collect();
          for (const o of ovrForItem) {
            // Single-item mappings only: a bundle's price is the BUNDLE's
            // price, not this item's, so it must not set the item's rate.
            if (o.components.length === 1 && String(o.components[0].item_id) === String(im.match!._id)) {
              pids.add(o.product_id);
            }
          }
          // Among this item's own listings prefer the CHEAPEST — that's the
          // base offering rather than an add-on bundle built around it.
          for (const l of listings) {
            if (!pids.has(l.product_id)) continue;
            if (typeof l.daily_price !== "number") continue;
            if (!best || l.daily_price < (best.daily_price as number)) best = l;
          }
          if (best) bestScore = 1;
        }
      }
      // Fallback: Jaccard over listing names (penalises the extra tokens a fat
      // bundle carries, unlike the old coverage score) with FULL query
      // coverage required, so every word the renter said must be present.
      if (!best) {
        const ranked = rankByName(item_name, listings, (l) => l.name ?? "");
        const top = ranked.find(
          (r) => r.coverage === 1 && typeof r.item.daily_price === "number",
        );
        if (top) {
          best = top.item;
          bestScore = top.score;
        }
      }
      if (best && bestScore >= 0.3 && typeof best.daily_price === "number") {
        const dailyRate = best.daily_price;
        const multiDayMult = days >= 30 ? 0.4 : days >= 7 ? 0.5 : days >= 3 ? 0.7 : 1.0;
        return {
          found: true as const,
          source: "hygglo_listing" as const,
          item_name,
          matched_listing: best.name,
          daily_rate_gbp: dailyRate,
          days,
          multi_day_multiplier: multiDayMult,
          listed_total_gbp: Math.round(dailyRate * days * multiDayMult * 100) / 100,
          included: best.description ?? null,
          distance_discount_applies: !!listing_location_non_central,
        };
      }
    }
    // Normalise: lowercase + trim. pricing_catalog stores `item_name_canonical`
    // which is usually lowercase already.
    const needle = item_name.toLowerCase().trim();

    // 1. Try exact match on canonical name (indexed).
    const exact = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", needle))
      .collect();

    let rows = exact;
    // 2. Fallback: substring scan over the whole table (~80-100 rows).
    if (rows.length === 0) {
      const all = await ctx.db.query("pricing_catalog").collect();
      rows = all.filter(
        (r) =>
          r.item_name_canonical.toLowerCase().includes(needle) ||
          needle.includes(r.item_name_canonical.toLowerCase()),
      );
    }

    if (rows.length === 0) {
      return {
        found: false as const,
        item_name,
        message: `No pricing row for "${item_name}". Treat price as 'check with Daniel'.`,
      };
    }

    // Use the lowest-min row (most conservative). Renter-bot should never
    // surface the inflated max from marketing-only listings.
    rows.sort((a, b) => a.daily_price_min - b.daily_price_min);
    const top = rows[0];

    // Multi-day soft discount: Hygglo applies ~50% on day 3, more on 7+.
    // Per appendix §C.6 — INTERNAL. We surface only the listed-total
    // estimate; never reveal % to the renter.
    const dailyRate = top.daily_price_min;
    const multiDayMult =
      days >= 30 ? 0.4 :
      days >= 7  ? 0.5 :
      days >= 3  ? 0.7 :
      1.0;
    const listedTotal = dailyRate * days * multiDayMult;

    // Distance discount: 10% if listing was non-central. Single-discount
    // rule (per appendix §B `One Discount Only`) — caller picks one.
    const distanceDiscountApplies = !!listing_location_non_central;

    return {
      found: true as const,
      item_name,
      matched_canonical: top.item_name_canonical,
      daily_rate_gbp: dailyRate,
      daily_rate_max_gbp: top.daily_price_max,
      days,
      multi_day_multiplier: multiDayMult,
      listed_total_gbp: Math.round(listedTotal * 100) / 100,
      distance_discount_applies: distanceDiscountApplies,
      // Internal — kept off-limits to renter per disclosure rules.
      is_bundle: !!top.is_bundle,
      marketing_only: !!top.marketing_only,
    };
  },
});

// ── Tool 4: check_availability ───────────────────────────────

export const check_availability = query({
  args: {
    item_name: v.string(),
    start_date: v.string(),   // ISO YYYY-MM-DD
    end_date: v.string(),      // ISO YYYY-MM-DD
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { item_name, start_date, end_date, account_slug }) => {
    // Pull reservations overlapping the window via by_start_date index.
    // start_date index lets us bound the scan; we filter end_date in code.
    // Window: start_date <= end AND end_date >= start.
    // We can't compose both sides with a single index, so we scan from
    // 30 days before start to end (covers any active rental).
    const windowStart = new Date(start_date);
    windowStart.setDate(windowStart.getDate() - 30);
    const windowStartIso = windowStart.toISOString().slice(0, 10);

    const candidates = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", windowStartIso))
      .collect();

    const needle = item_name.toLowerCase();
    const conflicts: Array<{
      account_slug: string | null;
      start_date: string | null;
      end_date: string | null;
      hygglo_order_id: string | null;
      status: string;
    }> = [];
    for (const r of candidates) {
      // account_slug intentionally NOT used to filter conflicts. DANIEL RULE 2
      // — Cross-Account Stock (knowledge base, priority 10): "Items are
      // listed multiple times across accounts BUT share the same physical
      // pool... only the master inventory checklist (cross-account) matters."
      // Filtering conflicts down to the asking thread's own account would
      // hide a real booking made under a sibling account for the same
      // physical item — false "available" on shared stock, exactly what this
      // rule forbids. Kept as an accepted param (agent still passes it) only
      // in case a future caller needs it for something other than gating
      // conflicts — do not reintroduce filtering here.
      if (!r.start_date || !r.end_date) continue;
      if (r.is_obsolete) continue;
      if (r.status === "cancelled" || r.status === "declined") continue;
      // Date overlap: r.start <= end_date AND r.end >= start_date
      if (r.start_date > end_date) continue;
      if (r.end_date < start_date) continue;

      const itemNames = [
        ...(r.items ?? []).map((i) => i.item_name.toLowerCase()),
        ...(r.hygglo_items ?? []).map((h) => h.name.toLowerCase()),
        ...(r.expanded_items ?? []).map((e) => e.item_name_canonical.toLowerCase()),
      ];
      const matchesItem = itemNames.some(
        (n) => n.includes(needle) || needle.includes(n),
      );
      if (!matchesItem) continue;

      conflicts.push({
        account_slug: r.account_slug ?? null,
        start_date: r.start_date,
        end_date: r.end_date,
        hygglo_order_id: r.hygglo_order_id ?? null,
        status: r.status,
      });
    }

    return {
      item_name,
      start_date,
      end_date,
      available: conflicts.length === 0,
      conflict_count: conflicts.length,
      conflicts: conflicts.slice(0, 5),   // never reveal renter names — only date overlap matters
      // 1-hour buffer rule lives in V1 — Phase 2 will add same-day-edge logic.
      buffer_violation: false,
    };
  },
});

// ── Tool 6: get_negotiation_stance ───────────────────────────

export const get_negotiation_stance = query({
  args: {
    thread_id: v.string(),
    latest_message: v.string(),
  },
  handler: async (ctx, { thread_id, latest_message }) => {
    const all = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("asc")
      .take(50);
    const renterMsgs = all
      .filter((m) => m.sender !== "owner")
      .map((m) => m.body_text);

    return computeNegotiationStance({
      latestMessage: latest_message,
      priorRenterMessages: renterMsgs,
    });
  },
});


// ── Tool: check_location (delivery distance, db-cinema-v2 method) ──────────────
// Geocode the renter's postcode + this account's hub via postcodes.io, haversine
// the distance, and check it against the account's delivery range (hub_max_km).
export const check_location = action({
  args: { renter_postcode: v.string(), account_slug: v.string() },
  handler: async (
    ctx,
    { renter_postcode, account_slug },
  ): Promise<Record<string, unknown>> => {
    const geocode = async (pc: string) => {
      const clean = pc.replace(/\s+/g, "").toUpperCase();
      if (clean.length < 5) return null;
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
        if (!r.ok) return null;
        const res = ((await r.json()) as { result?: { latitude?: number; longitude?: number; admin_ward?: string; admin_district?: string } })?.result;
        if (!res?.latitude || typeof res.longitude !== "number") return null;
        return {
          lat: res.latitude,
          lng: res.longitude,
          label: [res.admin_ward, res.admin_district].filter(Boolean).join(", "),
        };
      } catch {
        return null;
      }
    };
    const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const R = 6371;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };

    const hubs = (await ctx.runQuery(api.settings.listAccountHubs, {})) as Array<{
      slug: string; hub_postcode: string | null; hub_label: string | null;
    }>;
    const hub = hubs.find((h) => h.slug === account_slug);
    if (!hub?.hub_postcode) return { ok: false, reason: "No delivery hub set for this account — pickup only." };
    const hubGeo = await geocode(hub.hub_postcode);
    if (!hubGeo) return { ok: false, reason: "Couldn't resolve the hub location." };
    const renterGeo = await geocode(renter_postcode);
    if (!renterGeo) return { ok: false, reason: "That doesn't look like a full UK postcode — please re-send it." };

    const km = Math.round(haversineKm(hubGeo, renterGeo) * 10) / 10;
    const settings = (await ctx.runQuery(api.settings.get, {})) as { hub_max_km?: number; hub_heavy_max_km?: number } | null;
    const maxKm = settings?.hub_max_km ?? 30;
    const heavyMaxKm = settings?.hub_heavy_max_km ?? maxKm;
    const deliverable = km <= maxKm;
    return {
      ok: true,
      distance_km: km,
      hub_label: hub.hub_label ?? hub.hub_postcode,
      renter_area: renterGeo.label,
      max_km: maxKm,
      heavy_max_km: heavyMaxKm,
      within_delivery_range: deliverable,
      within_heavy_range: km <= heavyMaxKm,
      non_central: km > 5, // triggers the 10% distance discount rule
      note: deliverable
        ? `~${km}km from our ${hub.hub_label ?? "hub"} — within delivery range (offer delivery or pickup).`
        : `~${km}km — beyond our ${maxKm}km delivery range; offer pickup only.`,
    };
  },
});


// ── Tool: find_owned_alternatives ─────────────────────────────────────────────
// The account's OWNED, in-stock items (active, not marketing-only) — optionally
// filtered to one kind (lens, camera, drone...). Used to offer a REAL substitute
// when the renter asks for something we don't stock. Works for every account.
export const find_owned_alternatives = query({
  args: {
    account_slug: v.string(),
    kind: v.optional(v.string()),
    lens_mount: v.optional(v.string()),
    item_name: v.optional(v.string()),
    exclude_name: v.optional(v.string()),
  },
  handler: async (ctx, { account_slug, kind, lens_mount, item_name, exclude_name }) => {
    // Owned = active + not marketing-only + qty>0 on the SHARED items table
    // (accounts front the same gear). If kind is given AND real, narrow by it;
    // otherwise scan all and rank by NAME similarity to the requested item —
    // robust when a marketing listing has kind=null.
    // The `kind` taxonomy is NOT consistent across the catalog: the RED Komodo
    // is "camera_body" while every rentable camera is "camera". A kind-scoped
    // query therefore returned only marketing rows, filtered to ZERO owned
    // alternatives, and the caller silently got nothing to offer — which left
    // the draft with no grounding at all and escalated 100% of not-owned
    // inquiries. Normalise for comparison, and never let a kind filter be the
    // reason we have nothing to suggest.
    const normKind = (k?: string | null): string =>
      (k ?? "").toLowerCase().replace(/_?(body|bodies)$/, "").replace(/_+$/, "");
    const isOwned = (it: { status?: string; is_marketing_only?: boolean; qty?: number }) =>
      it.status === "active" && !it.is_marketing_only && (it.qty ?? 0) > 0;

    let base = kind
      ? await ctx.db.query("items").withIndex("by_kind", (q) => q.eq("kind", kind)).collect()
      : await ctx.db.query("items").collect();
    let owned = base.filter(isOwned);
    let kindFellBack = false;
    if (owned.length === 0) {
      // Either the kind was wrong/unknown, or everything of that kind is
      // marketing-only. Scan the whole catalog and let substitution ranking
      // (same normalised category, mount, family) pick — that is strictly
      // better than returning an empty list.
      base = await ctx.db.query("items").collect();
      owned = base.filter(isOwned);
      kindFellBack = true;
    }

    // NOTE (2026-08-21): the old local tokenizer here listed "pro", "full",
    // "frame", "camera" and "lens" as STOP words. That made "BMPCC 6K Pro" and
    // "BMPCC 6K Full Frame" both reduce to {bmpcc, 6k} — identical — so the
    // ranker could not tell two different camera bodies apart and happily
    // offered the wrong one. Ranking now uses the shared, variant-preserving
    // matcher in lib/item_name_match.ts instead.

    // Prices and wording are account-specific. Reading every account's fat
    // listing docs both mixed brands and dominated this tool's DB bandwidth.
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    // Resolve price by IDENTITY (item -> product_id index -> listing), the
    // same path lookup_pricing uses.
    //
    // The old implementation here matched listing NAME tokens at >=0.6
    // coverage and took the CHEAPEST hit. Live consequence: this tool quoted
    // the Sony FX3 at £18/day while lookup_pricing quoted the real £40/day
    // from its actual listing — so a single conversation said "£18/day" in one
    // turn and "£112 for 4 days" (£40/day) in another, and every substitution
    // we offered was under-priced. Identity, not similarity.
    const idxAll = await ctx.db.query("hygglo_product_index").collect();
    const listingByPid = new Map(listings.map((l) => [l.product_id, l]));
    const pidsForItem = (itemId: string): number[] =>
      idxAll
        .filter((r) => String(r.item_id) === itemId && r.account_slug === account_slug)
        .map((r) => r.product_id);
    // Curated fallback for items with no listing on THIS account — the same
    // source lookup_pricing falls back to, so the two tools cannot disagree.
    // Without it, switching to identity-only resolution left most
    // alternatives with a null price, which stops the bot quoting them at all.
    const catalog = await ctx.db.query("pricing_catalog").collect();
    const catalogPrice = new Map<string, number>();
    for (const row of catalog) {
      const k = row.item_name_canonical.toLowerCase().trim();
      const cur = catalogPrice.get(k);
      if (cur === undefined || row.daily_price_min < cur) catalogPrice.set(k, row.daily_price_min);
    }
    const priceFor = (itemId: string, name?: string): number | null => {
      let best: number | null = null;
      for (const pid of pidsForItem(itemId)) {
        const l = listingByPid.get(pid) as { daily_price?: number } | undefined;
        if (typeof l?.daily_price !== "number") continue;
        // Among an item's OWN listings prefer the cheapest — that's its base
        // offering rather than a bundle built around it.
        if (best === null || l.daily_price < best) best = l.daily_price;
      }
      if (best === null && name) best = catalogPrice.get(name.toLowerCase().trim()) ?? null;
      return best;
    };

    // Rank by SUBSTITUTABILITY, not bare name overlap. A renter asking for a
    // Blackmagic cinema body should be offered the other Blackmagic body (same
    // family, and ideally a mount their glass already fits) — not whichever
    // Sony happens to share the token "camera". Same-kind + same-mount +
    // shared family tokens all contribute; see lib/item_name_match.ts.
    let ranked = owned as typeof owned;
    let matchedBy = kind ? "kind" : "all";
    // The item being replaced — needed for mount/family affinity scoring.
    const targetName = item_name ?? exclude_name ?? null;
    let target: { name: string; kind?: string | null; lens_mount?: string | null } | null = null;
    if (targetName) {
      // Resolve against the FULL catalog, not just owned: the item being
      // replaced is very often the one we do NOT stock, so looking it up in
      // `owned` would never find it and we would lose its kind and mount —
      // exactly the signals that make a substitute sensible.
      const allForTarget = await ctx.db.query("items").collect();
      const tm = bestMatch(targetName, allForTarget, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      if (tm.match) {
        target = {
          name: tm.match.name_canonical,
          kind: tm.match.kind ?? null,
          lens_mount: tm.match.lens_mount ?? null,
        };
      } else {
        target = { name: targetName, kind: kind ?? null, lens_mount: lens_mount ?? null };
      }
    }
    if (target) {
      const t = target;
      const tn = { ...t, kind: normKind(t.kind) };
      ranked = owned
        .slice()
        .sort((a, b) =>
          substitutionScore(tn, { name: b.name_canonical, kind: normKind(b.kind), lens_mount: b.lens_mount }) -
          substitutionScore(tn, { name: a.name_canonical, kind: normKind(a.kind), lens_mount: a.lens_mount }),
        );
      matchedBy = "substitution";
    } else if (item_name) {
      const scored = rankByName(item_name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      if (scored.length) {
        ranked = scored.map((x) => x.item);
        matchedBy = "name";
      }
    }

    // What each alternative ACTUALLY comes with, resolved by IDENTITY via the
    // deterministic product_id index — never by matching the listing title.
    //
    // Listing titles are SEO keyword-stuffed and actively lie about identity:
    // the real BMPCC 6K Full Frame listing is titled "...Dual Native ISO)
    // Bmpcc 6k pro camera cinema", i.e. it contains the RIVAL body's full name.
    // Any title-similarity lookup (including a Jaccard one) therefore hands
    // back the wrong body's kit. Identity-only, or nothing.
    //
    // Returning null when there is no mapping is deliberate and correct: the
    // agent must say it will confirm, not invent contents. Inventing is exactly
    // what produced "comes with cage, 1TB card, and batteries" for a body that
    // has no listing at all.
    const describeFor = (
      itemId: string,
    ): { included: string | null; listing: string | null } => {
      for (const pid of pidsForItem(itemId)) {
        const l = listingByPid.get(pid) as { name?: string; description?: string } | undefined;
        if (l && (l.description || l.name)) {
          return { included: l.description ?? null, listing: l.name ?? null };
        }
      }
      return { included: null, listing: null };
    };

    const exclude = (exclude_name ?? "").toLowerCase().trim();
    const targetLower = (item_name ?? "").toLowerCase().trim();
    const alternatives: Array<Record<string, unknown>> = [];
    for (const it of ranked) {
      const nameLower = it.name_canonical.toLowerCase();
      // Never offer the very item being replaced back as its own alternative.
      if (exclude && nameLower === exclude) continue;
      if (targetLower && nameLower === targetLower) continue;
      // Normalised compare: inventory spells the same mount several ways
      // ("Canon EF mount" vs "EF"), and an exact compare silently filtered out
      // every genuinely-compatible lens.
      if (lens_mount && it.lens_mount && !sameMount(it.lens_mount, lens_mount)) continue;
      // With a known target, keep suggestions in the same category. Offering a
      // lens as a substitute for a camera body is never useful.
      if (target?.kind && it.kind && normKind(it.kind) !== normKind(target.kind)) continue;
      const d = describeFor(String(it._id));
      alternatives.push({
        name: it.name_canonical,
        kind: it.kind,
        lens_mount: it.lens_mount ?? null,
        daily_price_gbp: priceFor(String(it._id), it.name_canonical),
        // TRUNCATED (2026-08-21). `included` is a full Hygglo listing
        // description — SEO marketing copy that runs 700+ chars each. Times 8
        // alternatives that made this the largest tool payload in the system
        // (4.7KB, vs 180B-1.5KB for every other tool), and the agent loop
        // re-sends every prior tool result on each subsequent step, so the
        // cost was multiplied by step count.
        //
        // The decisive facts for choosing an ALTERNATIVE are its name, price,
        // mount and whether it ships with glass — `includes_lens` below already
        // carries the last one. The full kit text for the item actually being
        // discussed still comes through get_listing_context untruncated, so
        // nothing is lost for the question that needs it.
        included: d.included ? d.included.slice(0, 240) : null,
        listing_name: d.listing,
        // Does this alternative ship WITH glass? Drives "lens not included,
        // but I can add one" instead of silently dropping the question.
        includes_lens:
          d.included || d.listing
            ? /\blens|\d{2,3}\s*-?\s*\d{0,3}\s*mm\b/i.test(`${d.included ?? ""} ${d.listing ?? ""}`)
            : null,
      });
      // 6, not 8. The route only ever shows the top 5 and the craft rules say
      // to offer ONE (at most two) — the tail was never used, but was re-sent
      // on every subsequent agent step.
      if (alternatives.length >= 6) break;
    }
    void account_slug;
    return {
      kind: kind ?? null,
      matched_by: matchedBy,
      kind_fell_back: kindFellBack,
      target: target?.name ?? null,
      count: alternatives.length,
      alternatives,
    };
  },
});

/**
 * Mount adapters we own and rent.
 *
 * Why this exists: the bot correctly told a renter the Blazar Remus lenses are
 * native PL and "would require a PL-to-EF adapter, which isn't included" — and
 * then stopped there. We own five mount adapters. A blocker we can actually
 * sell the fix for should never be delivered as a dead end.
 *
 * Selection is by CANONICAL NAME PATTERN over our own inventory ("X to Y
 * mount"), which is exact and auditable — it deliberately excludes "V-mount
 * 150Wh"/"V-mount 95Wh", which are batteries, not adapters. This is not a
 * similarity match against listing titles.
 */
export const get_mount_adapters = query({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const ADAPTER_RE = /^\s*([a-z0-9 ]+?)\s+to\s+([a-z0-9 ]+?)\s*mount\s*$/i;
    const items = (await ctx.db.query("items").collect()).filter(
      (i) =>
        i.status === "active" &&
        !i.is_marketing_only &&
        (i.qty ?? 0) > 0 &&
        ADAPTER_RE.test(i.name_canonical),
    );
    if (items.length === 0) return { adapters: [] };

    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const idxAll = await ctx.db.query("hygglo_product_index").collect();
    const listingByPid = new Map(listings.map((l) => [l.product_id, l]));
    const catalog = await ctx.db.query("pricing_catalog").collect();
    const catalogPrice = new Map<string, number>();
    for (const row of catalog) {
      const k = row.item_name_canonical.toLowerCase().trim();
      const cur = catalogPrice.get(k);
      if (cur === undefined || row.daily_price_min < cur) catalogPrice.set(k, row.daily_price_min);
    }
    // Identity-first, cheapest own listing, then the curated catalog — the same
    // order lookup_pricing and find_owned_alternatives use, so the three tools
    // cannot quote different numbers for one item.
    const priceFor = (itemId: string, name: string): number | null => {
      let best: number | null = null;
      for (const r of idxAll) {
        if (String(r.item_id) !== itemId || r.account_slug !== account_slug) continue;
        const l = listingByPid.get(r.product_id) as { daily_price?: number } | undefined;
        if (typeof l?.daily_price !== "number") continue;
        if (best === null || l.daily_price < best) best = l.daily_price;
      }
      return best ?? catalogPrice.get(name.toLowerCase().trim()) ?? null;
    };

    return {
      adapters: items.map((i) => {
        const m = i.name_canonical.match(ADAPTER_RE);
        return {
          name: i.name_canonical,
          from_mount: (m?.[1] ?? "").trim(),
          to_mount: (m?.[2] ?? "").trim(),
          qty: i.qty ?? 0,
          daily_price_gbp: priceFor(String(i._id), i.name_canonical),
        };
      }),
    };
  },
});
