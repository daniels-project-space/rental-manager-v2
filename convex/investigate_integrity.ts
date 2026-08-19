import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Inventory/availability integrity sweep — checks NOT covered by earlier passes.
 *
 * Each is a state that should be impossible if the system is consistent, so any
 * hit is a real defect rather than a heuristic guess.
 */
export const gather = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const items = await ctx.db.query("items").collect();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    // ── 1. Holds exceeding available units on a date (live oversell) ────────
    const holds = await ctx.db.query("calendar_holds").collect();
    const future = holds.filter((h) => (h.date ?? "") >= today);
    const perItemDate = new Map<string, number>();
    for (const h of future) {
      const k = `${String(h.item_id)}|${h.date}`;
      perItemDate.set(k, (perItemDate.get(k) ?? 0) + (h.qty_held ?? 1));
    }
    const oversold: string[] = [];
    for (const [k, used] of perItemDate.entries()) {
      const [itemId, date] = k.split("|");
      const item = byId.get(itemId);
      if (!item) continue;
      const total = item.qty ?? 0;
      if (used > total) {
        oversold.push(`${item.name_canonical} on ${date}: ${used} held vs qty ${total}`);
      }
    }

    // ── 2. Holds whose reservation is gone or cancelled (stale blockers) ────
    const staleHolds: string[] = [];
    const seenRes = new Map<string, string | null>();
    for (const h of future) {
      if (!h.reservation_id) continue;
      const rid = String(h.reservation_id);
      if (!seenRes.has(rid)) {
        const r = await ctx.db.get(h.reservation_id);
        seenRes.set(rid, r ? String(r.status ?? "") : null);
      }
      const status = seenRes.get(rid);
      if (status === null) {
        staleHolds.push(`${byId.get(String(h.item_id))?.name_canonical ?? "?"} ${h.date} — reservation DELETED`);
      } else if (["cancelled", "declined"].includes(status ?? "")) {
        staleHolds.push(`${byId.get(String(h.item_id))?.name_canonical ?? "?"} ${h.date} — reservation ${status}`);
      }
    }

    // ── 3. Marketing-only items that nonetheless hold stock ────────────────
    const marketingHeld = [
      ...new Set(
        future
          .map((h) => byId.get(String(h.item_id)))
          .filter((i) => i && i.is_marketing_only)
          .map((i) => i!.name_canonical),
      ),
    ];

    // ── 4. Active, non-marketing items with qty 0 (unrentable but offered) ──
    const zeroQty = items
      .filter((i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) === 0)
      .map((i) => i.name_canonical);

    // ── 5. Same product_id in BOTH map tables (ambiguous resolution) ────────
    const index = await ctx.db.query("hygglo_product_index").collect();
    const overrides = await ctx.db.query("listing_resolution_override").collect();
    const idxKeys = new Set(index.map((r) => `${r.account_slug}#${r.product_id}`));
    // Presence in both tables is only a DEFECT when they disagree: the
    // override wins, so a conflicting index row is silently dead and would
    // mislead anyone reading or editing it.
    const idxByKey = new Map(
      index.map((r) => [`${r.account_slug}#${r.product_id}`, String(r.item_id)]),
    );
    const doubleMapped: string[] = [];
    const conflicting: string[] = [];
    for (const o of overrides) {
      const key = `${o.account_slug}#${o.product_id}`;
      const idxItem = idxByKey.get(key);
      if (!idxItem) continue;
      doubleMapped.push(key);
      const ovrIds = o.components.map((c) => String(c.item_id));
      // Superset (override contains the index item plus kit parts) is FINE —
      // the override wins and is strictly more complete. Only a CONTRADICTION,
      // where the override does not contain the index item at all, is a defect:
      // one of the two is wrong, and the index row is silently dead.
      if (!ovrIds.includes(idxItem)) {
        conflicting.push(
          `${key}: index="${byId.get(idxItem)?.name_canonical ?? "?"}" vs override=[${ovrIds
            .map((id) => byId.get(id)?.name_canonical ?? "?")
            .join(", ")}]`,
        );
      }
    }

    // ── 6. Map rows pointing at a deleted item ─────────────────────────────
    const dangling = [
      ...index
        .filter((r) => !byId.has(String(r.item_id)))
        .map((r) => `index ${r.account_slug}#${r.product_id}`),
      ...overrides
        .filter((r) => r.components.some((c) => !byId.has(String(c.item_id))))
        .map((r) => `override ${r.account_slug}#${r.product_id}`),
    ];

    return {
      futureHolds: future.length,
      oversoldCount: oversold.length,
      oversold: oversold.slice(0, 12),
      staleHoldCount: staleHolds.length,
      staleHolds: staleHolds.slice(0, 12),
      marketingHeld,
      zeroQtyActive: zeroQty,
      doubleMappedCount: doubleMapped.length,
      conflictingCount: conflicting.length,
      conflicting: conflicting.slice(0, 20),
      dangling,
    };
  },
});

/**
 * Detail view for the conflicting keys: what does the LISTING actually say?
 * The title is the tiebreaker — index and override cannot both be right.
 */
export const conflictDetail = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const index = await ctx.db.query("hygglo_product_index").collect();
    const idxByKey = new Map(index.map((r) => [`${r.account_slug}#${r.product_id}`, r]));
    const overrides = await ctx.db.query("listing_resolution_override").collect();

    const out: Record<string, unknown>[] = [];
    for (const o of overrides) {
      const key = `${o.account_slug}#${o.product_id}`;
      const idx = idxByKey.get(key);
      if (!idx) continue;
      const ovrIds = o.components.map((c) => String(c.item_id));
      if (ovrIds.includes(String(idx.item_id))) continue; // superset — fine

      const prod = await ctx.db
        .query("hygglo_products")
        .withIndex("by_account_product", (q) =>
          q.eq("accountSlug", o.account_slug).eq("productId", o.product_id),
        )
        .first();

      out.push({
        key,
        title: prod?.name ?? idx.sample_title ?? "(no title found)",
        index_item: byId.get(String(idx.item_id))?.name_canonical ?? "?",
        index_source: idx.source,
        override_items: o.components.map(
          (c) => `${byId.get(String(c.item_id))?.name_canonical ?? "?"} x${c.qty}`,
        ),
        override_source: o.source ?? "(none)",
        override_note: o.note ?? "(none)",
      });
    }
    return out;
  },
});

export const detail = internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_integrity.conflictDetail, {}),
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_integrity.gather, {}),
});
