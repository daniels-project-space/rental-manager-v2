/**
 * Listing-location resolution (2026-06-27).
 *
 * Resolves the pickup/listing location Hygglo shows for an order — label, street,
 * postcode and EXACT lat/lng — from the public listing endpoint (no auth), and
 * caches it on the reservation. Distance-from-hub + the too-heavy tag are derived
 * live at read time (assembleTile), so they track the Settings hub automatically.
 *
 *   GET https://api.hygglo.com/api/v2/product-listings/{listingId}?country=GB
 *     → location: { label, street, zip, zipLatitude, zipLongitude,
 *                   municipality, bestLocation:{ name, position:{coordinates:[lng,lat]} } }
 */
import { v } from "convex/values";
import { action, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classifyOrderWeight } from "./lib/delivery_weight";

type ParsedLoc = {
  label?: string;
  area?: string;
  municipality?: string;
  street?: string;
  zip?: string;
  lat: number;
  lng: number;
  publicUrl?: string;
};

function parseLoc(l: unknown): ParsedLoc | null {
  if (!l || typeof l !== "object") return null;
  const o = l as Record<string, any>;
  const lat = typeof o.zipLatitude === "number" ? o.zipLatitude : o.bestLocation?.position?.coordinates?.[1];
  const lng = typeof o.zipLongitude === "number" ? o.zipLongitude : o.bestLocation?.position?.coordinates?.[0];
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    label: o.label ?? o.bestLocation?.label ?? o.bestLocation?.name,
    area: o.bestLocation?.name,
    municipality: o.municipality,
    street: o.street,
    zip: o.zip,
    lat,
    lng,
  };
}

async function fetchListingLocation(listingId: number): Promise<ParsedLoc | null> {
  try {
    const r = await fetch(
      `https://api.hygglo.com/api/v2/product-listings/${listingId}?country=GB`,
      { headers: { Country: "GB", "User-Client": "Hygglo-web" } },
    );
    if (!r.ok) return null;
    const d = (await r.json()) as { location?: unknown; publicUrl?: string };
    const parsed = parseLoc(d?.location);
    if (parsed && d?.publicUrl) parsed.publicUrl = d.publicUrl;
    return parsed;
  } catch {
    return null;
  }
}

export const resolveInput = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const res = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    if (!res) return null;
    const slug = res.account_slug ?? null;
    const productIds = (res.hygglo_items ?? [])
      .map((h) => h.product_id)
      .filter((x): x is number => typeof x === "number");

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

    let listingId: number | undefined;
    let publicUrl: string | undefined;
    let storedLoc: unknown;
    if (slug) {
      for (const pid of productIds) {
        const prod = await ctx.db
          .query("hygglo_products")
          .withIndex("by_account_product", (q) =>
            q.eq("accountSlug", slug).eq("productId", pid),
          )
          .first();
        const lst = prod?.listings?.[0];
        if (lst?.id) {
          listingId = lst.id;
          publicUrl = lst.publicUrl ?? prod?.publicUrl;
          storedLoc = lst.location;
          break;
        }
      }
    }
    return {
      reservation_id: res._id,
      listingId: listingId ?? null,
      publicUrl: publicUrl ?? null,
      storedLoc: storedLoc ?? null,
      items,
      resolved_at: res.loc_resolved_at ?? null,
    };
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

/** Resolve (and cache) one thread's listing location + weight summary. */
export const resolveForThread = action({
  args: { thread_id: v.string(), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { thread_id, force },
  ): Promise<{ ok: boolean; cached?: boolean; reason?: string }> => {
    const inp = await ctx.runQuery(internal.locations.resolveInput, { thread_id });
    if (!inp) return { ok: false, reason: "no reservation" };
    if (inp.resolved_at && !force) return { ok: true, cached: true };

    let loc = parseLoc(inp.storedLoc);
    if (!loc && inp.listingId != null) loc = await fetchListingLocation(inp.listingId);
    if (!loc) return { ok: false, reason: "no location" };

    const order = classifyOrderWeight(
      inp.items.map((it) => ({ spec: it, qty: it.qty })),
    );
    await ctx.runMutation(internal.locations.patchLocation, {
      reservation_id: inp.reservation_id,
      loc: {
        loc_label: loc.label,
        loc_area: loc.area,
        loc_municipality: loc.municipality,
        loc_street: loc.street,
        loc_zip: loc.zip,
        loc_lat: loc.lat,
        loc_lng: loc.lng,
        loc_public_url: inp.publicUrl ?? loc.publicUrl,
        loc_total_weight_kg: order.totalWeightKg,
        loc_heaviest_kg: order.heaviestKg,
        loc_big_items: order.bigItems,
        loc_vehicle: order.vehicle,
      },
    });
    return { ok: true };
  },
});

/** Thread ids (awaiting reply) that still need a location resolved. */
export const unresolvedThreads = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .take(400);
    const out: string[] = [];
    for (const conv of convs) {
      const res = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) =>
          q.eq("hygglo_order_id", conv.thread_id),
        )
        .first();
      if (res && !res.loc_resolved_at) out.push(conv.thread_id);
      if (out.length >= limit) break;
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
      const r = await ctx.runAction(api.locations.resolveForThread, {
        thread_id: t,
      });
      if (r.ok) resolved++;
    }
    return { resolved };
  },
});
