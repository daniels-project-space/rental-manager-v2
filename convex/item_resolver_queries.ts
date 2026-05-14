/**
 * Internal queries/mutations supporting the item_resolver action.
 * Kept in a separate module so the action (which runs in Node) doesn't
 * mix server-only code with internal Convex helpers.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

export const getReservationForResolve = internalQuery({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    const r = await ctx.db.get(reservation_id);
    if (!r) return null;
    return {
      _id: r._id,
      items: r.items ?? [],
      resolved_items: (r as any).resolved_items ?? undefined,
      resolution_input_hash: (r as any).resolution_input_hash ?? undefined,
    };
  },
});

export const getInventoryForResolve = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    return all
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        _id: i._id as string,
        name_canonical: i.name_canonical,
        aliases: i.aliases ?? [],
        kind: i.kind,
        notes: i.notes,
      }));
  },
});

export const setResolution = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
    })),
    expanded_items: v.optional(v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    }))),
    method: v.string(),
    input_hash: v.string(),
  },
  handler: async (ctx, { reservation_id, resolved_items, expanded_items, method, input_hash }) => {
    await ctx.db.patch(reservation_id, {
      resolved_items,
      expanded_items,
      resolution_at: Date.now(),
      resolution_method: method,
      resolution_input_hash: input_hash,
    });
    return { ok: true };
  },
});

/**
 * Returns up to `limit` reservation IDs that need resolution.
 * "Need" = has items, AND (no resolution OR resolution_input_hash is stale).
 * Stale check is computed inline (cheap — items is small) by hashing items[].
 */
export const listUnresolved = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const all = await ctx.db.query("reservations").collect();
    const need: { id: typeof all[number]["_id"]; created: number }[] = [];
    for (const r of all) {
      if (!r.items || r.items.length === 0) continue;
      if (r.is_obsolete) continue;
      const currentHash = (r.items ?? []).map((i) => i.item_name).sort().join("|");
      const stored = (r as any).resolution_input_hash;
      const resolved = (r as any).resolved_items;
      if (resolved !== undefined && stored === currentHash) continue;
      need.push({ id: r._id, created: r._creationTime });
    }
    // Newest first — most likely to be visible on the dashboard right now.
    need.sort((a, b) => b.created - a.created);
    return need.slice(0, limit).map((n) => n.id);
  },
});


/** Returns every bundle with its bundle_items joined. Used by the
 *  item_resolver action to expand kit listings into physical components. */
export const getBundlesWithItems = internalQuery({
  args: {},
  handler: async (ctx) => {
    const bundles = await ctx.db.query("bundles").collect();
    const out: Array<{
      bundle_id: string;
      slug: string;
      bundle_name: string;
      items: Array<{ item_id: string | undefined; item_name_canonical: string; qty: number }>;
    }> = [];
    for (const b of bundles) {
      const items = await ctx.db
        .query("bundle_items")
        .withIndex("by_bundle", (q) => q.eq("bundle_id", b._id))
        .collect();
      out.push({
        bundle_id: b._id as string,
        slug: b.slug,
        bundle_name: b.bundle_name,
        items: items.map((i) => ({
          item_id: i.item_id as string | undefined,
          item_name_canonical: i.item_name_canonical,
          qty: i.qty,
        })),
      });
    }
    return out;
  },
});
