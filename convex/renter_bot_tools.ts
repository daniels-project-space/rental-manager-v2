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
import { query } from "./_generated/server";
import { v } from "convex/values";
import { stageFromReservationStatus } from "./lib/renter_bot_intents";
import { computeNegotiationStance } from "./lib/renter_bot_negotiation";

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

    const last3 = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .take(3);

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
      last_messages: last3
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
    if (!reservation) {
      return {
        thread_id,
        found: false as const,
        items: [],
        account_slug: null,
      };
    }
    // Prefer hygglo_items (per-item snapshot from Hygglo, authoritative
    // for what's actually on this booking) — falls back to items[] then
    // expanded_items[].
    const items =
      (reservation.hygglo_items?.map((h) => ({
        name: h.name,
        qty: h.qty ?? 1,
        type: h.type ?? "RENTAL",
      })) ?? null) ??
      (reservation.items?.map((i) => ({
        name: i.item_name,
        qty: i.qty ?? 1,
        type: "RENTAL",
      })) ?? null) ??
      [];
    const expanded =
      reservation.expanded_items?.map((e) => ({
        name: e.item_name_canonical,
        qty: e.qty,
      })) ?? [];

    return {
      thread_id,
      found: true as const,
      account_slug: reservation.account_slug ?? null,
      items,
      expanded_items: expanded,
      start_date: reservation.start_date ?? null,
      end_date: reservation.end_date ?? null,
      gross_paid_gbp: reservation.gross_paid_gbp ?? null,
      pickup_time: reservation.pickup_time ?? null,
      return_time: reservation.return_time ?? null,
      order_step: reservation.order_step ?? null,
    };
  },
});

// ── Tool 3: lookup_pricing ───────────────────────────────────

export const lookup_pricing = query({
  args: {
    item_name: v.string(),
    days: v.optional(v.number()),
    listing_location_non_central: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { item_name, days = 1, listing_location_non_central },
  ) => {
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
      if (account_slug && r.account_slug !== account_slug) continue;
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
