import { v } from "convex/values";
import { query, mutation } from "./owner_functions";
import { realisedMonthRevenue } from "./lib/reservations/monthRevenue";
import { allocate, balances, pence, validMonth } from "./lib/finance/payouts";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
async function monthSource(ctx: QueryCtx, month: string) {
  const end = month + "-32";
  const [starting, pickedUp, claims] = await Promise.all([
    ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) =>
        q.gte("start_date", month + "-01").lt("start_date", end),
      )
      .collect(),
    ctx.db
      .query("reservations")
      .withIndex("by_pickup_date", (q) =>
        q.gte("pickup_date", month + "-01").lt("pickup_date", end),
      )
      .collect(),
    ctx.db.query("insurance_claims").collect(),
  ]);
  const rentals = Array.from(
    new Map([...starting, ...pickedUp].map((r) => [r._id, r])).values(),
  );
  return pence(
    realisedMonthRevenue(rentals, month).netGbp +
      claims
        .filter((c) => c.credited_to_month === month)
        .reduce((s, c) => s + (c.payout_amount_gbp ?? 0), 0),
  );
}
function expensesFor(entries: Doc<"finance_entries">[], month: string) {
  return entries.filter(
    (e) =>
      !e.voided &&
      e.kind === "expense" &&
      (e.month === month ||
        (e.recurring &&
          e.month <= month &&
          (!e.end_month || month <= e.end_month))),
  );
}
export const overview = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    validMonth(month);
    const [source, entries, snapshots, audit] = await Promise.all([
      monthSource(ctx, month),
      ctx.db.query("finance_entries").collect(),
      ctx.db.query("finance_snapshots").collect(),
      ctx.db
        .query("finance_audit")
        .withIndex("by_created")
        .order("desc")
        .take(50),
    ]);
    const latest = new Map<string, Doc<"finance_snapshots">>();
    for (const s of snapshots)
      if (!latest.has(s.month) || latest.get(s.month)!.revision < s.revision)
        latest.set(s.month, s);
    const totals = Array.from(latest.values()).reduce(
      (sum, s) => ({ Daniel: sum.Daniel + s.daniel, Leo: sum.Leo + s.leo }),
      { Daniel: 0, Leo: 0 },
    );
    const expenses = expensesFor(entries, month);
    const history = Array.from(latest.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((snapshot) => {
        const allocations = Array.from(latest.values())
          .filter((s) => s.month <= snapshot.month)
          .reduce(
            (sum, s) => ({
              Daniel: sum.Daniel + s.daniel,
              Leo: sum.Leo + s.leo,
            }),
            { Daniel: 0, Leo: 0 },
          );
        return {
          ...snapshot,
          carried: balances(
            allocations,
            entries.filter((e) => !e.voided && e.month <= snapshot.month),
          ),
        };
      })
      .reverse();
    return {
      source,
      expenses: expenses.reduce((s, e) => s + e.amount, 0),
      expenseRows: expenses,
      entries: entries.sort((a, b) => b.created_at - a.created_at),
      months: history,
      revisions: snapshots
        .filter((s) => s.month === month)
        .sort((a, b) => b.revision - a.revision),
      current: latest.get(month) ?? null,
      totals: balances(
        totals,
        entries.filter((e) => !e.voided),
      ),
      audit,
    };
  },
});
export const freeze = mutation({
  args: {
    month: v.string(),
    danielBps: v.number(),
    overrideGbp: v.optional(v.number()),
    note: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    validMonth(args.month);
    if (!args.note.trim()) throw Error("Add a snapshot note");
    const rows = await ctx.db
      .query("finance_snapshots")
      .withIndex("by_month", (q) => q.eq("month", args.month))
      .collect();
    const revision = Math.max(0, ...rows.map((r) => r.revision));
    if (revision !== args.expectedRevision)
      throw Error("Snapshot changed. Refresh and try again.");
    const source = await monthSource(ctx, args.month);
    const entries = expensesFor(
      await ctx.db.query("finance_entries").collect(),
      args.month,
    );
    const expenses = entries.reduce((s, e) => s + e.amount, 0);
    const revenue =
      args.overrideGbp === undefined ? source : pence(args.overrideGbp);
    const profit = revenue - expenses;
    const shares = allocate(profit, args.danielBps);
    const actor = (await ctx.auth.getUserIdentity())?.subject ?? "owner";
    const record = {
      month: args.month,
      revision: revision + 1,
      revenue,
      expenses,
      profit,
      daniel_bps: args.danielBps,
      daniel: shares.Daniel,
      leo: shares.Leo,
      source_revenue: source,
      expense_ids: entries.map((e) => e._id),
      note: args.note.trim(),
      created_at: Date.now(),
      actor,
    };
    const id = await ctx.db.insert("finance_snapshots", record);
    await ctx.db.insert("finance_audit", {
      target: String(id),
      operation: "freeze",
      after: record,
      reason: args.note,
      actor,
      created_at: Date.now(),
    });
    return id;
  },
});
export const saveEntry = mutation({
  args: {
    id: v.optional(v.id("finance_entries")),
    expectedUpdatedAt: v.optional(v.number()),
    kind: v.union(
      v.literal("expense"),
      v.literal("withdrawal"),
      v.literal("settlement"),
    ),
    month: v.string(),
    person: v.optional(v.union(v.literal("Daniel"), v.literal("Leo"))),
    amountGbp: v.number(),
    label: v.string(),
    recurring: v.boolean(),
    endMonth: v.optional(v.string()),
    voided: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    validMonth(args.month);
    if (args.endMonth) {
      validMonth(args.endMonth);
      if (args.endMonth < args.month) throw Error("End month precedes start");
    }
    if (!args.label.trim() || !args.reason.trim())
      throw Error("Label and reason are required");
    const amount = pence(args.amountGbp);
    if (amount === 0 || (args.kind !== "withdrawal" && amount < 0))
      throw Error("Enter a valid non-zero amount");
    if (args.kind !== "expense" && !args.person) throw Error("Choose a person");
    if (args.recurring && args.kind !== "expense")
      throw Error("Only expenses can repeat");
    const before = args.id ? await ctx.db.get(args.id) : null;
    if (args.id && (!before || before.updated_at !== args.expectedUpdatedAt))
      throw Error("Entry changed. Refresh and try again.");
    const record = {
      kind: args.kind,
      month: args.month,
      person: args.kind === "expense" ? undefined : args.person,
      amount,
      label: args.label.trim(),
      recurring: args.recurring,
      end_month: args.endMonth,
      voided: args.voided,
      updated_at: Date.now(),
    };
    const id =
      args.id ??
      (await ctx.db.insert("finance_entries", {
        ...record,
        created_at: Date.now(),
      }));
    if (args.id) await ctx.db.patch(args.id, record);
    await ctx.db.insert("finance_audit", {
      target: String(id),
      operation: args.voided ? "void" : before ? "edit" : "add",
      ...(before ? { before } : {}),
      after: record,
      reason: args.reason,
      actor: (await ctx.auth.getUserIdentity())?.subject ?? "owner",
      created_at: Date.now(),
    });
    return id;
  },
});
