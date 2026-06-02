// Phase 12: product_id-keyed listing image bank.
// See: /root/listing-image-bank-investigation.md
//
// Decouples dashboard tile imagery from per-rental snapshot. The bank is the
// new source of truth; legacy reservations.hygglo_items[i].image_url is the
// fallback. Poller writes through on every cycle. Backfill walks existing
// reservations.

import { v } from "convex/values";
import {
  mutation as _mutation,
  internalMutation,
  query,
  internalQuery as _internalQuery,
} from "./_generated/server";
import { internal as _internal } from "./_generated/api";

// Silence unused-import warnings (kept exported for future expansion):
void _mutation;
void _internalQuery;
void _internal;

const _sourceLiteral = v.union(
  v.literal("hygglo_api"),
  v.literal("hygglo_scrape"),
  v.literal("manual"),
);
void _sourceLiteral;

// ── Poller write-through ──────────────────────────────────────
// Internal mutation called by hygglo.ts after buildHyggloItems(). Upserts
// (account_slug, product_id) rows from the hygglo items array.
export const upsertFromHyggloItems = internalMutation({
  args: {
    account_slug: v.string(),
    items: v.array(
      v.object({
        product_id: v.optional(v.number()),
        slug: v.optional(v.string()),
        image_url: v.union(v.string(), v.null()),
        name: v.string(),
        type: v.string(),
      }),
    ),
  },
  handler: async (ctx, { account_slug, items }) => {
    let upserts = 0;
    let updated = 0;
    let inserted = 0;
    const seen = new Set<number>(); // dedupe within this batch
    for (const it of items) {
      if (!it.product_id || it.type === "INSURANCE" || !it.image_url) continue;
      if (seen.has(it.product_id)) continue;
      seen.add(it.product_id);

      const existing = await ctx.db
        .query("listing_images")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", account_slug).eq("product_id", it.product_id!),
        )
        .first();

      if (existing) {
        // Update only if URL or name changed (cheap drift detection).
        if (
          existing.image_url !== it.image_url ||
          existing.name_at_capture !== it.name
        ) {
          await ctx.db.patch(existing._id, {
            image_url: it.image_url,
            name_at_capture: it.name,
            captured_at: Date.now(),
            slug: it.slug ?? existing.slug,
          });
          updated++;
        }
      } else {
        await ctx.db.insert("listing_images", {
          product_id: it.product_id,
          slug: it.slug,
          account_slug,
          image_url: it.image_url,
          name_at_capture: it.name,
          source: "hygglo_api",
          captured_at: Date.now(),
        });
        inserted++;
      }
      upserts++;
    }
    return { upserts, inserted, updated };
  },
});

// ── Dashboard read ────────────────────────────────────────────
// Returns rows scoped by account_slug (or all when null).
export const listForAccount = query({
  args: { account_slug: v.union(v.string(), v.null()) },
  handler: async (ctx, { account_slug }) => {
    if (account_slug) {
      const rows = await ctx.db
        .query("listing_images")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", account_slug),
        )
        .collect();
      return rows.map((r) => ({
        product_id: r.product_id,
        image_url: r.image_url,
        name_at_capture: r.name_at_capture,
      }));
    }
    const rows = await ctx.db.query("listing_images").collect();
    return rows.map((r) => ({
      product_id: r.product_id,
      image_url: r.image_url,
      account_slug: r.account_slug,
      name_at_capture: r.name_at_capture,
    }));
  },
});

// ── Backfill ──────────────────────────────────────────────────
// Walks reservations.hygglo_items[] and populates the bank from existing data.
export const backfillFromReservations = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 1000;
    const rows = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-off backfill (internalMutation)
    const grouped = new Map<
      string,
      {
        account_slug: string;
        product_id: number;
        image_url: string;
        name: string;
        slug: string | undefined;
        captured_at: number;
      }
    >();
    for (const r of rows) {
      const acc = (r as any).account_slug as string | undefined;
      const hi = (r as any).hygglo_items as
        | Array<{
            product_id?: number;
            image_url: string | null;
            name: string;
            type?: string;
            slug?: string;
          }>
        | undefined;
      if (!acc || !Array.isArray(hi)) continue;
      for (const it of hi) {
        if (!it.product_id || !it.image_url) continue;
        if (it.type === "INSURANCE") continue;
        const key = `${acc}#${it.product_id}`;
        // Prefer the row with the most recent capture
        // (reservation _creationTime as proxy).
        const ct = r._creationTime ?? 0;
        const existing = grouped.get(key);
        if (!existing || ct > existing.captured_at) {
          grouped.set(key, {
            account_slug: acc,
            product_id: it.product_id,
            image_url: it.image_url,
            name: it.name,
            slug: it.slug,
            captured_at: ct,
          });
        }
      }
    }
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let processed = 0;
    for (const [, g] of grouped) {
      if (processed >= cap) break;
      processed++;
      const existing = await ctx.db
        .query("listing_images")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", g.account_slug).eq("product_id", g.product_id),
        )
        .first();
      if (existing) {
        if (
          existing.image_url !== g.image_url ||
          existing.name_at_capture !== g.name
        ) {
          await ctx.db.patch(existing._id, {
            image_url: g.image_url,
            name_at_capture: g.name,
            captured_at: Date.now(),
            slug: g.slug ?? existing.slug,
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await ctx.db.insert("listing_images", {
          product_id: g.product_id,
          slug: g.slug,
          account_slug: g.account_slug,
          image_url: g.image_url,
          name_at_capture: g.name,
          source: "hygglo_api",
          captured_at: Date.now(),
        });
        inserted++;
      }
    }
    return {
      totalUniquePairs: grouped.size,
      processed,
      inserted,
      updated,
      skipped,
      remaining: Math.max(0, grouped.size - processed),
    };
  },
});

// ── Diagnostics ───────────────────────────────────────────────
export const coverageReport = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("listing_images").collect();
    const byAccount = new Map<string, number>();
    for (const r of all) {
      byAccount.set(r.account_slug, (byAccount.get(r.account_slug) ?? 0) + 1);
    }
    return { total: all.length, byAccount: Object.fromEntries(byAccount) };
  },
});
