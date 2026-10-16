import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { projectReservationRevenue, refreshReservationRevenue, revenueFactMatches } from "./lib/reservation_revenue";

export const status = internalQuery({ args: {}, handler: async (ctx) => ({
  progress: await ctx.db.query("reservation_revenue_state").withIndex("by_key", (q) => q.eq("key", "v1")).unique(),
  readiness: await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique(),
}) });

/** One authoritative checkpoint per call. Original reservation data is never written. */
export const step = internalMutation({
  args: { pageSize: v.optional(v.number()) },
  handler: async (ctx, { pageSize = 25 }) => {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("Use a page size from 1 to 50");
    const prior = await ctx.db.query("reservation_revenue_state").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
    const progress = prior ? { ...prior } : {
      key: "v1" as const, phase: "backfill" as Doc<"reservation_revenue_state">["phase"], cursor: null as string | null,
      backfilled: 0, audited: 0, facts_audited: 0, mismatches: 0, updated_at: Date.now(),
    };
    if (!prior) {
      const readiness = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
      if (readiness?.ready) await ctx.db.patch(readiness._id, { ready: false, updated_at: Date.now() });
    }
    if (progress.phase === "ready" || progress.phase === "failed") return progress;
    const fail = async () => {
      const readiness = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
      if (readiness?.ready) await ctx.db.patch(readiness._id, { ready: false, updated_at: Date.now() });
      progress.phase = "failed";
    };
    if (progress.phase === "backfill") {
      const page = await ctx.db.query("reservations").paginate({ cursor: progress.cursor, numItems: pageSize, maximumBytesRead: 3_000_000 });
      for (const source of page.page) await refreshReservationRevenue(ctx, source._id);
      progress.backfilled += page.page.length;
      progress.cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) progress.phase = "audit_source";
    } else if (progress.phase === "audit_source") {
      const page = await ctx.db.query("reservations").paginate({ cursor: progress.cursor, numItems: pageSize, maximumBytesRead: 3_000_000 });
      for (const source of page.page) {
        const actual = await ctx.db.query("reservation_revenue_facts").withIndex("by_source", (q) => q.eq("source_id", source._id)).unique();
        const expected = projectReservationRevenue(source);
        if (!revenueFactMatches(actual, expected)) progress.mismatches++;
      }
      progress.audited += page.page.length;
      progress.cursor = page.isDone ? null : page.continueCursor;
      if (progress.mismatches) await fail();
      else if (page.isDone) progress.phase = "audit_facts";
    } else {
      // Each source document can be up to 1 MiB; keep point reads below the
      // transaction budget even when a compact fact refers to a large source.
      const page = await ctx.db.query("reservation_revenue_facts").paginate({ cursor: progress.cursor, numItems: Math.min(pageSize, 10), maximumBytesRead: 1_000_000 });
      for (const actual of page.page) {
        const source = await ctx.db.get(actual.source_id);
        const expected = source ? projectReservationRevenue(source) : null;
        if (!expected || !revenueFactMatches(actual, expected)) progress.mismatches++;
      }
      progress.facts_audited += page.page.length;
      progress.cursor = page.isDone ? null : page.continueCursor;
      if (progress.mismatches) await fail();
      else if (page.isDone) {
        const readiness = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
        if (readiness) await ctx.db.patch(readiness._id, { ready: true, updated_at: Date.now() });
        else await ctx.db.insert("reservation_revenue_ready", { key: "v1", ready: true, updated_at: Date.now() });
        progress.phase = "ready";
      }
    }
    progress.updated_at = Date.now();
    const { _id, _creationTime, ...data } = progress as Doc<"reservation_revenue_state">;
    if (prior) await ctx.db.patch(prior._id, data);
    else await ctx.db.insert("reservation_revenue_state", data);
    return data;
  },
});

/** Roll back to the original reader before rebuilding or deploying legacy writers. */
export const reset = internalMutation({ args: {}, handler: async (ctx) => {
  const readiness = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
  if (readiness) await ctx.db.patch(readiness._id, { ready: false, updated_at: Date.now() });
  const progress = await ctx.db.query("reservation_revenue_state").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
  if (progress) await ctx.db.delete(progress._id);
  return { ready: false };
} });
