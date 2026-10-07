import { internalMutation } from "./owner_functions";
import { internal } from "./_generated/api";
import { INVOICE_STATS_VERSION, recordInvoiceStats, readInvoiceGroups } from "./lib/invoice_stats";
import { emptyInvoiceStats, invoiceContribution, type InvoiceStats } from "./lib/invoice_stats_fields";

/** Bounded, resumable backfill; concurrent invoice updates share the ledger. */
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("invoice_stats_state")
      .withIndex("by_version", q => q.eq("version", INVOICE_STATS_VERSION)).unique();
    if (state?.complete) return { complete: true, processed: 0 };
    const page = await ctx.db.query("invoice_archive").paginate({ cursor: state?.cursor ?? null, numItems: 100 });
    for (const row of page.page) await recordInvoiceStats(ctx, row);
    const value = { version: INVOICE_STATS_VERSION, cursor: page.continueCursor, complete: page.isDone };
    if (state) await ctx.db.patch(state._id, value);
    else await ctx.db.insert("invoice_stats_state", value);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.invoice_stats.backfill, {});
    return { complete: page.isDone, processed: page.page.length };
  },
});

/** One-time production comparison against the former full-scan calculation. */
export const verify = internalMutation({
  args: {},
  handler: async (ctx) => {
    const actual = await readInvoiceGroups(ctx, true);
    if (!actual) return { complete: false, equal: false, invoices: 0, mismatches: [] as string[] };
    const rows = await ctx.db.query("invoice_archive").collect();
    const expected: Record<string, InvoiceStats> = {};
    for (const row of rows) {
      const group = expected[row.account_slug] ??= emptyInvoiceStats();
      const contribution = invoiceContribution(row);
      for (const key of Object.keys(group) as Array<keyof InvoiceStats>) group[key] += contribution[key];
    }
    const mismatches: string[] = [];
    for (const account of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      for (const key of Object.keys(emptyInvoiceStats()) as Array<keyof InvoiceStats>) {
        if (Math.abs((actual[account]?.[key] ?? 0) - (expected[account]?.[key] ?? 0)) > 1e-8) mismatches.push(`${account}:${key}`);
      }
    }
    const state = await ctx.db.query("invoice_stats_state")
      .withIndex("by_version", q => q.eq("version", INVOICE_STATS_VERSION)).unique();
    if (!state) throw new Error("Invoice stats state missing");
    await ctx.db.patch(state._id, { verified: mismatches.length === 0 });
    return { complete: true, equal: mismatches.length === 0, invoices: rows.length, mismatches };
  },
});

/** Reversible fallback to the original scan; never deletes archive or ledger. */
export const deactivate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("invoice_stats_state")
      .withIndex("by_version", q => q.eq("version", INVOICE_STATS_VERSION)).unique();
    if (state) await ctx.db.patch(state._id, { verified: false });
  },
});
