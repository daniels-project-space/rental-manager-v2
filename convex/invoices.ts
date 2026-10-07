import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  requireOwner,
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./owner_functions";
import { internal } from "./_generated/api";
import { patchInvoice, readInvoiceGroups, recordInvoiceStats } from "./lib/invoice_stats";
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const result = await ctx.db
      .query("invoice_archive")
      .withIndex("by_date")
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...row,
          pdfUrl: row.pdf_id ? await ctx.storage.getUrl(row.pdf_id) : null,
          textUrl: row.text_id ? await ctx.storage.getUrl(row.text_id) : null,
        })),
      ),
    };
  },
});
export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    const cachedGroups = await readInvoiceGroups(ctx);
    const rows = cachedGroups ? [] : await ctx.db.query("invoice_archive").collect();
    const groups: Record<
      string,
      {
        count: number;
        ready: number;
        review: number;
        failed: number;
        queued: number;
        revenue: number;
        lenderFee: number;
        renterFee: number;
        payout: number;
        revenueKnown: number;
        lenderKnown: number;
        renterKnown: number;
        payoutKnown: number;
      }
    > = cachedGroups ?? {};
    for (const r of rows) {
      const key = r.account_slug;
      const g = (groups[key] ??= {
        count: 0,
        ready: 0,
        review: 0,
        failed: 0,
        queued: 0,
        revenue: 0,
        lenderFee: 0,
        renterFee: 0,
        payout: 0,
        revenueKnown: 0,
        lenderKnown: 0,
        renterKnown: 0,
        payoutKnown: 0,
      });
      g.count++;
      if (r.status === "ready") g.ready++;
      else if (r.status === "review") g.review++;
      else if (r.status === "failed") g.failed++;
      else g.queued++;
      if (r.status !== "ready" || !r.pdf_id || r.amounts?.currency !== "GBP")
        continue;
      for (const [field, total, known] of [
        ["revenue", "revenue", "revenueKnown"],
        ["lender_fee", "lenderFee", "lenderKnown"],
        ["renter_fee", "renterFee", "renterKnown"],
        ["payout", "payout", "payoutKnown"],
      ] as const) {
        const value = r.amounts?.[field];
        if (value !== undefined) {
          g[total] += value;
          g[known]++;
        }
      }
    }
    return {
      groups,
      logs: await ctx.db
        .query("invoice_sync_log")
        .withIndex("by_created")
        .order("desc")
        .take(30),
    };
  },
});
export const retry = mutation({
  args: { id: v.id("invoice_archive") },
  handler: async (ctx, { id }) => {
    await requireOwner(ctx, true);
    const row = await ctx.db.get(id);
    if (!row) throw Error("Invoice missing");
    if (row.status === "downloading" && row.lease_until > Date.now())
      throw Error("Download in progress");
    await patchInvoice(ctx, id, {
      status: "queued",
      attempts: 0,
      next_retry: 0,
      error: undefined,
      updated_at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.invoice_sync.drain, {});
  },
});
export const accounts = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("accounts").collect()).map((a) => a.slug),
});
export const ingest = internalMutation({
  args: {
    account: v.string(),
    rows: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        date: v.string(),
        price: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let added = 0;
    for (const row of args.rows) {
      const found = await ctx.db
        .query("invoice_archive")
        .withIndex("by_source", (q) =>
          q.eq("account_slug", args.account).eq("source_id", row.id),
        )
        .unique();
      if (!found) {
        const id = await ctx.db.insert("invoice_archive", {
          account_slug: args.account,
          source_id: row.id,
          title: row.title,
          date: row.date,
          price_label: row.price,
          status: "queued",
          attempts: 0,
          lease_until: 0,
          next_retry: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        const inserted = await ctx.db.get(id);
        if (!inserted) throw new Error("Inserted invoice missing");
        await recordInvoiceStats(ctx, inserted);
        added++;
      }
    }
    return added;
  },
});
export const log = internalMutation({
  args: { account: v.string(), message: v.string(), count: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("invoice_sync_log", {
      account_slug: args.account,
      message: args.message,
      count: args.count,
      created_at: Date.now(),
    });
  },
});
export const claim = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Expired leases are eligible again; status-indexed reads keep each drain bounded.
    for (const r of await ctx.db
      .query("invoice_archive")
      .withIndex("by_status_retry", (q) => q.eq("status", "downloading"))
      .take(20))
      if (r.lease_until < now)
        await patchInvoice(ctx, r._id, { status: "queued", next_retry: now });
    const rows = await ctx.db
      .query("invoice_archive")
      .withIndex("by_status_retry", (q) =>
        q.eq("status", "queued").lte("next_retry", now),
      )
      .take(3);
    for (const row of rows)
      await patchInvoice(ctx, row._id, {
        status: "downloading",
        attempts: row.attempts + 1,
        lease_until: now + 180000,
        updated_at: now,
      });
    return rows.map((row) => ({
      ...row,
      attempts: row.attempts + 1,
      lease_until: now + 180000,
    }));
  },
});
export const finish = internalMutation({
  args: {
    id: v.id("invoice_archive"),
    lease: v.number(),
    pdf: v.id("_storage"),
    text: v.id("_storage"),
    sha: v.string(),
    verified: v.boolean(),
    error: v.optional(v.string()),
    amounts: v.object({
      revenue: v.optional(v.number()),
      lender_fee: v.optional(v.number()),
      renter_fee: v.optional(v.number()),
      payout: v.optional(v.number()),
      currency: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.status !== "downloading" ||
      row.lease_until !== args.lease
    ) {
      await ctx.storage.delete(args.pdf);
      await ctx.storage.delete(args.text);
      return;
    }
    if (row.pdf_id) await ctx.storage.delete(row.pdf_id);
    if (row.text_id) await ctx.storage.delete(row.text_id);
    await patchInvoice(ctx, args.id, {
      status: args.verified ? "ready" : "review",
      pdf_id: args.pdf,
      text_id: args.text,
      sha256: args.sha,
      amounts: args.amounts,
      error: args.error,
      lease_until: 0,
      updated_at: Date.now(),
    });
  },
});
export const fail = internalMutation({
  args: { id: v.id("invoice_archive"), lease: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.lease_until !== args.lease) return;
    await patchInvoice(ctx, args.id, {
      status: row.attempts >= 5 ? "failed" : "queued",
      error: args.message,
      next_retry: Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts),
      lease_until: 0,
      updated_at: Date.now(),
    });
  },
});
