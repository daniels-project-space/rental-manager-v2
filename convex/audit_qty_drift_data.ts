/**
 * Data-layer companion to convex/audit_qty_drift.ts.
 * Convex requires queries/mutations to live outside `"use node"` actions.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

interface AuditCandidate {
  _id: import("./_generated/dataModel").Id<"reservations">;
  hygglo_order_id?: string;
  account_slug?: string;
  renter_name?: string;
  items_length: number;
  expanded_items_n: number;
  expanded_unique_skus: number;
}

/**
 * Pull reservations worth auditing. By default `only_active=true` scopes to
 * status=confirmed rows with end_date >= today-1d AND items.length > 1 (single-
 * listing orders can't drift). Returns lightweight projections so the action
 * runtime stays under the 60s/100MB budget.
 */
export const listAuditCandidates = internalQuery({
  args: {
    account_slug: v.optional(v.string()),
    only_active: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { account_slug, only_active = true, limit = 500 }) => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Phase 7a (2026-05-24): swap the unindexed full-table collect on the
    // global path (`account_slug` omitted) for a status-indexed read.
    // The weekly cron always passes only_active=true; combined with the
    // by_status / by_account_status index, that drops the scan from
    // ~1700 rows → ~300 confirmed rows per run.
    let rows;
    if (account_slug && only_active) {
      rows = await ctx.db
        .query("reservations")
        .withIndex("by_account_status", (q) =>
          q.eq("account_slug", account_slug).eq("status", "confirmed"),
        )
        .collect();
    } else if (account_slug) {
      rows = await ctx.db
        .query("reservations")
        .withIndex("by_account_slug", (q) => q.eq("account_slug", account_slug))
        .collect();
    } else if (only_active) {
      rows = await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", "confirmed"))
        .collect();
    } else {
      rows = await ctx.db.query("reservations").collect();
    }

    const out: AuditCandidate[] = [];
    for (const r of rows) {
      const itemsLen = Array.isArray(r.items) ? r.items.length : 0;
      if (itemsLen <= 1) continue; // single-listing orders can't drift
      if (only_active) {
        if (r.status !== "confirmed") continue;
        if (r.is_obsolete) continue;
        if (!r.end_date) continue;
        if ((r.end_date as string) < yesterday) continue;
      }
      const expanded = Array.isArray(r.expanded_items) ? r.expanded_items : [];
      const expanded_items_n = expanded.reduce((s, e) => s + (e.qty ?? 0), 0);
      const expanded_unique_skus = new Set(expanded.map((e) => String(e.item_id))).size;
      out.push({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id,
        account_slug: r.account_slug,
        renter_name: r.renter_name,
        items_length: itemsLen,
        expanded_items_n,
        expanded_unique_skus,
      });
      if (out.length >= limit) break;
    }
    return out;
  },
});

/**
 * Upsert (close + reopen pattern): if an open row already exists for this
 * reservation, patch it; else insert. Idempotent so the nightly cron can re-run
 * without spamming duplicates.
 */
export const upsertDriftAlert = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    hygglo_order_id: v.string(),
    renter_name: v.optional(v.string()),
    account_slug: v.optional(v.string()),
    drift_kind: v.union(
      v.literal("listing_count_lt_items"),
      v.literal("unique_sku_lt_items"),
    ),
    raw_n: v.number(),
    expanded_n: v.number(),
    missing_skus: v.optional(v.array(v.string())),
    detected_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("qty_drift_alerts")
      .withIndex("by_reservation", (q) =>
        q.eq("reservation_id", args.reservation_id),
      )
      .collect();
    const open = existing.find((e) => e.status === "open");
    if (open) {
      await ctx.db.patch(open._id, {
        drift_kind: args.drift_kind,
        raw_n: args.raw_n,
        expanded_n: args.expanded_n,
        missing_skus: args.missing_skus,
        detected_at: args.detected_at,
      });
      return { id: open._id, action: "updated" as const };
    }
    const id = await ctx.db.insert("qty_drift_alerts", {
      reservation_id: args.reservation_id,
      hygglo_order_id: args.hygglo_order_id,
      renter_name: args.renter_name,
      account_slug: args.account_slug,
      drift_kind: args.drift_kind,
      raw_n: args.raw_n,
      expanded_n: args.expanded_n,
      missing_skus: args.missing_skus,
      detected_at: args.detected_at,
      status: "open" as const,
    });
    return { id, action: "inserted" as const };
  },
});

/**
 * Count of open drift rows scoped to an account (or global if slug omitted).
 * Read by dashboard.ts:getStatsDrawerData to surface `qty_drift_count`.
 */
export const countOpenDrift = internalQuery({
  args: { account_slug: v.optional(v.string()) },
  handler: async (ctx, { account_slug }) => {
    if (account_slug) {
      const rows = await ctx.db
        .query("qty_drift_alerts")
        .withIndex("by_account_status", (q) =>
          q.eq("account_slug", account_slug).eq("status", "open"),
        )
        .collect();
      return rows.length;
    }
    const rows = await ctx.db
      .query("qty_drift_alerts")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    return rows.length;
  },
});

/**
 * Public query variant for dashboard reads (CriticalAlerts widget hookup).
 * Returns count + lightweight list (first 10 rows) so the badge can link to
 * a meaningful list view without a follow-up query.
 */
export const dashboardDriftSummary = internalQuery({
  args: { account_slug: v.optional(v.string()) },
  handler: async (ctx, { account_slug }) => {
    const rows = account_slug
      ? await ctx.db
          .query("qty_drift_alerts")
          .withIndex("by_account_status", (q) =>
            q.eq("account_slug", account_slug).eq("status", "open"),
          )
          .collect()
      : await ctx.db
          .query("qty_drift_alerts")
          .withIndex("by_status", (q) => q.eq("status", "open"))
          .collect();
    return {
      count: rows.length,
      sample: rows.slice(0, 10).map((r) => ({
        reservation_id: r.reservation_id as string,
        hygglo_order_id: r.hygglo_order_id,
        renter_name: r.renter_name ?? null,
        drift_kind: r.drift_kind,
        raw_n: r.raw_n,
        expanded_n: r.expanded_n,
      })),
    };
  },
});
