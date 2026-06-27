/**
 * Per-order pickup/meetup location (2026-06-27, reworked).
 *
 * The authoritative location for an order is on the AUTH'd order detail
 * (GET /v4/my/orders/{id}) as `location: { street, zip, municipality }` — the
 * agreed handover point for THAT order. (The earlier version guessed the
 * listing's fixed area via product→listings[0], which was the seller's default
 * area and wrong for almost every order.) The zip has no coords, so we geocode
 * it with postcodes.io (the same address register the hub uses).
 *
 * Cached on the reservation; distance-from-hub + the heavy tag are derived live
 * in replyInbox.computeLocation against the order's OWN account hub.
 */
import { action, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { classifyOrderWeight } from "./lib/delivery_weight";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const TZ = "Europe/London";

export const resolveInput = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const res = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    if (!res || !res.account_slug) return null;
    const items: { weight_kg?: number; size_score?: number; kind?: string; qty: number }[] = [];
    for (const ri of res.resolved_items ?? []) {
      const idAny = (ri as { item_id?: unknown }).item_id;
      if (!idAny) continue;
      const it = await ctx.db.get(idAny as Id<"items">);
      if (it)
        items.push({
          weight_kg: it.weight_kg ?? undefined,
          size_score: it.size_score ?? undefined,
          kind: it.kind,
          qty: (ri as { qty?: number }).qty ?? 1,
        });
    }
    return { reservation_id: res._id, account_slug: res.account_slug, items, resolved_at: res.loc_resolved_at ?? null };
  },
});

export const patchLocation = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    loc: v.object({
      loc_label: v.optional(v.string()),
      loc_area: v.optional(v.string()),
      loc_municipality: v.optional(v.string()),
      loc_street: v.optional(v.string()),
      loc_zip: v.optional(v.string()),
      loc_lat: v.optional(v.number()),
      loc_lng: v.optional(v.number()),
      loc_public_url: v.optional(v.string()),
      loc_total_weight_kg: v.optional(v.number()),
      loc_heaviest_kg: v.optional(v.number()),
      loc_big_items: v.optional(v.number()),
      loc_vehicle: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { reservation_id, loc }) => {
    await ctx.db.patch(reservation_id, { ...loc, loc_resolved_at: Date.now() });
  },
});

/** GET the auth'd order detail's location { street, zip, municipality }. */
async function fetchOrderLocation(
  accountSlug: string,
  hyggloOrderId: string,
): Promise<{ street?: string; zip?: string; municipality?: string } | null> {
  try {
    const creds = await getAccountCredentials(accountSlug);
    const token = await getHyggloAccessToken({ ...creds, accountSlug });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(hyggloOrderId)}?timezone=${encodeURIComponent(TZ)}`,
      { headers: hyggloAuthHeaders(token) },
    );
    if (!res.ok) return null;
    const d = (await res.json()) as { location?: { street?: string; zip?: string; municipality?: string } };
    return d.location ?? null;
  } catch {
    return null;
  }
}

/** Geocode a UK postcode via postcodes.io (the address register). */
async function geocodeZip(
  zip: string,
): Promise<{ lat: number; lng: number; label: string; postcode: string } | null> {
  const pc = zip.replace(/\s+/g, "").toUpperCase();
  if (pc.length < 5) return null;
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    if (!r.ok) return null;
    const res = (await r.json())?.result;
    if (!res || typeof res.latitude !== "number") return null;
    const label =
      [res.admin_ward, res.admin_district].filter(Boolean).join(", ") ||
      res.admin_district ||
      res.parish ||
      res.postcode ||
      pc;
    return { lat: res.latitude, lng: res.longitude, label, postcode: res.postcode ?? pc };
  } catch {
    return null;
  }
}

/** Resolve (and cache) one thread's per-order location + weight summary. */
export const resolveForThread = action({
  args: { thread_id: v.string(), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { thread_id, force },
  ): Promise<{ ok: boolean; cached?: boolean; reason?: string; label?: string }> => {
    const inp = await ctx.runQuery(internal.locations.resolveInput, { thread_id });
    if (!inp) return { ok: false, reason: "no reservation" };
    if (inp.resolved_at && !force) return { ok: true, cached: true };

    const orderLoc = await fetchOrderLocation(inp.account_slug, thread_id);
    if (!orderLoc?.zip) return { ok: false, reason: "no order location" };
    const geo = await geocodeZip(orderLoc.zip);
    if (!geo) return { ok: false, reason: "geocode failed" };

    const order = classifyOrderWeight(inp.items.map((it) => ({ spec: it, qty: it.qty })));
    await ctx.runMutation(internal.locations.patchLocation, {
      reservation_id: inp.reservation_id,
      loc: {
        loc_label: geo.label,
        loc_area: orderLoc.municipality ?? geo.label,
        loc_municipality: orderLoc.municipality,
        loc_street: orderLoc.street,
        loc_zip: geo.postcode,
        loc_lat: geo.lat,
        loc_lng: geo.lng,
        loc_total_weight_kg: order.totalWeightKg,
        loc_heaviest_kg: order.heaviestKg,
        loc_big_items: order.bigItems,
        loc_vehicle: order.vehicle,
      },
    });
    return { ok: true, label: geo.label };
  },
});

/** Active threads (requests + renter-last) still missing a location. */
export const unresolvedThreads = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const consider = async (tid: string | undefined, resHas: boolean) => {
      if (!tid || seen.has(tid) || out.length >= limit) return;
      seen.add(tid);
      if (resHas) out.push(tid);
    };
    const reqs = await ctx.db
      .query("reservations")
      .withIndex("by_awaiting_owner_action", (q) => q.eq("awaiting_owner_action", true))
      .take(200);
    for (const r of reqs) await consider(r.hygglo_order_id, !r.loc_resolved_at);
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .take(400);
    for (const conv of convs) {
      if (out.length >= limit) break;
      const res = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", conv.thread_id))
        .first();
      if (res && !res.loc_resolved_at) await consider(conv.thread_id, true);
    }
    return out;
  },
});

/** Cron: backfill locations for active threads, capped per run. */
export const resolveActive = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ resolved: number }> => {
    const threads = await ctx.runQuery(internal.locations.unresolvedThreads, {
      limit: limit ?? 30,
    });
    let resolved = 0;
    for (const t of threads) {
      const r = await ctx.runAction(api.locations.resolveForThread, { thread_id: t });
      if (r.ok) resolved++;
    }
    return { resolved };
  },
});
