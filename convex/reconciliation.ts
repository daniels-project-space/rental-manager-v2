import { v } from "convex/values";
import { query } from "./owner_functions";
import type { Doc } from "./_generated/dataModel";
import { DEAD_ORDER_STEPS } from "./order_step_semantics";

const deadSteps = new Set<string>(DEAD_ORDER_STEPS);
function project(row: Doc<"reservations">) {
  return {
    _id: row._id, hygglo_order_id: row.hygglo_order_id, account_slug: row.account_slug,
    start_date: row.start_date, end_date: row.end_date, pickup_date: row.pickup_date, return_date: row.return_date,
    order_step: row.order_step, status: row.status, is_obsolete: row.is_obsolete,
    items: row.items, resolved_items: row.resolved_items, expanded_items: row.expanded_items, renter_name: row.renter_name,
  };
}

/** One fresh snapshot after all account upserts, retaining actual hold cleanup. */
export const listBatch = query({
  args: { account_slugs: v.array(v.string()) },
  handler: async (ctx, { account_slugs }) => {
    const accounts = [...new Set(account_slugs)];
    if (accounts.length > 8) throw new Error("Reconciliation supports up to eight accounts per batch");
    if (!accounts.length) return { strategy: "held-index" as const, groups: [] };
    const today = new Date();
    const lookback = new Date(today); lookback.setUTCDate(lookback.getUTCDate() - 400);
    const cutoff = lookback.toISOString().slice(0, 10);
    const past = new Date(today); past.setUTCDate(past.getUTCDate() - 30);
    const pastCutoff = past.toISOString().slice(0, 10);
    const held = await ctx.db.query("calendar_holds").take(4001);
    const ids = [...new Set(held.map(h => h.reservation_id).filter(id => id !== undefined))];
    // Never silently truncate. Larger deployments retain the original exact
    // history scan until their hold-reference index can be normalized safely.
    if (held.length > 4000 || ids.length > 1000) {
      const groups = [];
      for (const account_slug of accounts) {
        const rows = await ctx.db.query("reservations").withIndex("by_account_start", q =>
          q.eq("account_slug", account_slug).gte("start_date", cutoff)).collect();
        groups.push({ account_slug, reservations: rows.map(project) });
      }
      return { strategy: "history-fallback" as const, groups };
    }
    // The reservation owns the account identity. Historic holds sometimes
    // carry another account's slug; do not trust that denormalized field for
    // cleanup. Read each held reservation once across the entire poll cycle.
    const terminal: Doc<"reservations">[] = [];
    for (let offset = 0; offset < ids.length; offset += 32) {
      const rows = await Promise.all(ids.slice(offset, offset + 32).map(id => ctx.db.get(id)));
      for (const row of rows) {
        if (row && row.account_slug && accounts.includes(row.account_slug) &&
          typeof row.start_date === "string" && row.start_date >= cutoff &&
          (row.is_obsolete || (row.order_step && deadSteps.has(row.order_step)))) terminal.push(row);
      }
    }
    const groups = [];
    for (const account_slug of accounts) {
      const candidates: Doc<"reservations">[] = terminal.filter(row => row.account_slug === account_slug);
      // Exclude obsolete history in the index, before reading its documents.
      // Legacy missing flags remain eligible exactly like explicit false.
      for (const obsolete of [false, undefined] as const) {
        const [ending, extended] = await Promise.all([
          ctx.db.query("reservations").withIndex("by_account_obsolete_end", q =>
            q.eq("account_slug", account_slug).eq("is_obsolete", obsolete).gte("end_date", pastCutoff)).collect(),
          ctx.db.query("reservations").withIndex("by_account_obsolete_return", q =>
            q.eq("account_slug", account_slug).eq("is_obsolete", obsolete).gte("return_date", pastCutoff)).collect(),
        ]);
        candidates.push(...ending, ...extended);
      }
      const rows = [...new Map(candidates.filter(row => typeof row.start_date === "string" && row.start_date >= cutoff)
        .map(row => [row._id, row])).values()]
        .sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? "") || a._creationTime - b._creationTime);
      groups.push({ account_slug, reservations: rows.map(project) });
    }
    return { strategy: "held-index" as const, groups };
  },
});
