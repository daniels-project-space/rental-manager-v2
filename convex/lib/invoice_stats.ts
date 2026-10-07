import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyInvoiceStats, invoiceContribution, type InvoiceStats } from "./invoice_stats_fields";

export const INVOICE_STATS_VERSION = "invoice-stats-v1";

/** A per-invoice ledger makes writes and paginated backfill idempotent. */
export async function recordInvoiceStats(ctx: MutationCtx, row: Doc<"invoice_archive">) {
  const prior = await ctx.db.query("invoice_stats_ledger")
    .withIndex("by_invoice", q => q.eq("invoice_id", row._id)).unique();
  const contribution = invoiceContribution(row);
  if (prior?.account_slug === row.account_slug &&
    Object.keys(contribution).every(key => prior.contribution[key as keyof InvoiceStats] === contribution[key as keyof InvoiceStats])) return;

  const accounts = new Set([row.account_slug, ...(prior ? [prior.account_slug] : [])]);
  for (const account of accounts) {
    const group = await ctx.db.query("invoice_stats_groups")
      .withIndex("by_account", q => q.eq("account_slug", account)).unique();
    const totals = { ...(group?.totals ?? emptyInvoiceStats()) };
    for (const key of Object.keys(totals) as Array<keyof InvoiceStats>) {
      if (prior?.account_slug === account) totals[key] -= prior.contribution[key];
      if (row.account_slug === account) totals[key] += contribution[key];
    }
    if (group) await ctx.db.patch(group._id, { totals });
    else await ctx.db.insert("invoice_stats_groups", { account_slug: account, totals });
  }
  if (prior) await ctx.db.patch(prior._id, { account_slug: row.account_slug, contribution });
  else await ctx.db.insert("invoice_stats_ledger", { invoice_id: row._id, account_slug: row.account_slug, contribution });
}

/** Every archive update and its summary commit in the same transaction. */
export async function patchInvoice(ctx: MutationCtx, id: Id<"invoice_archive">, patch: Partial<Doc<"invoice_archive">>) {
  await ctx.db.patch(id, patch);
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Invoice disappeared during update");
  await recordInvoiceStats(ctx, row);
}

export async function readInvoiceGroups(ctx: QueryCtx, includeUnverified = false): Promise<Record<string, InvoiceStats> | null> {
  const state = await ctx.db.query("invoice_stats_state")
    .withIndex("by_version", q => q.eq("version", INVOICE_STATS_VERSION)).unique();
  if (!state?.complete || (!includeUnverified && !state.verified)) return null;
  const rows = await ctx.db.query("invoice_stats_groups").collect();
  return Object.fromEntries(rows.filter(row => row.totals.count > 0).map(row => [row.account_slug, row.totals]));
}
