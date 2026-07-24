/**
 * Apple Calendar integration — DB layer (queries + mutations).
 * The CalDAV/network side lives in `calendar_apple.ts` ("use node"), which can
 * only hold actions; Convex requires queries/mutations in a non-node file.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

export type ResForCal = {
  thread_id: string; account_slug: string | null; renter_name: string; items: string[];
  status: string; pickup_date: string | null; pickup_time: string | null;
  return_date: string | null; return_time: string | null; pickup_address: string | null;
  member_thread_ids?: string[];
};

export const _getConnection = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("calendar_connection").first()) ?? null,
});

export const _saveConnection = internalMutation({
  args: { patch: v.any() },
  handler: async (ctx, { patch }) => {
    const row = await ctx.db.query("calendar_connection").first();
    if (row) await ctx.db.patch(row._id, { ...patch, updated_at: Date.now() });
    else await ctx.db.insert("calendar_connection", { provider: "apple", status: "disconnected", ...patch, updated_at: Date.now() });
  },
});

export const _getReservationForCal = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<ResForCal | null> => {
    const r = await ctx.db.query("reservations").withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id)).first();
    if (!r) return null;
    const a = r as Record<string, unknown>;
    // Hygglo extensions are separate orders. Collapse contiguous orders for the
    // same renter + exact listing into one calendar event pair.
    const productKey = (row: any) => JSON.stringify((row.hygglo_items ?? []).map((x: any) => x.product_id ?? x.slug).sort());
    const all = await ctx.db.query("reservations").withIndex("by_account_status", (q) => q.eq("account_slug", r.account_slug ?? "").eq("status", "confirmed")).collect();
    const targetKey = productKey(r);
    const same = all.filter((x: any) => !x.is_obsolete && productKey(x) === targetKey && (x.renter_id ? x.renter_id === r.renter_id : x.renter_name === r.renter_name));
    const shiftDay = (date: string | undefined, days: number) => {
      if (!date) return "";
      const value = new Date(`${date}T00:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    };
    // Treat same-day and next-day re-bookings as one extension chain. Hygglo
    // creates a separate order starting the day after the prior raw end date.
    const members = same.filter((x: any) =>
      (x.start_date ?? "") <= shiftDay(r.end_date, 1) &&
      (x.end_date ?? "") >= shiftDay(r.start_date, -1),
    );
    members.sort((x: any, y: any) => String(x.pickup_date ?? x.start_date).localeCompare(String(y.pickup_date ?? y.start_date)));
    const first: any = members[0] ?? r;
    const latest: any = members.reduce((best: any, x: any) => {
      const moment = `${x.return_date ?? x.end_date ?? ""}T${x.return_time ?? ""}`;
      const bestMoment = `${best.return_date ?? best.end_date ?? ""}T${best.return_time ?? ""}`;
      return moment > bestMoment ? x : best;
    }, first);
    let pickup_address: string | null = null;
    if (a.account_slug) {
      const acc = (await ctx.db.query("accounts").collect()).find((x) => x.slug === a.account_slug);
      if (acc) {
        const prof = await ctx.db.query("account_profiles").withIndex("by_account", (q) => q.eq("account_id", acc._id)).first();
        pickup_address = (prof as { pickup_address?: string } | null)?.pickup_address ?? null;
      }
    }
    return {
      thread_id: (first.hygglo_order_id as string) ?? thread_id, member_thread_ids: members.map((x: any) => x.hygglo_order_id).filter(Boolean), account_slug: (a.account_slug as string) ?? null,
      renter_name: (a.renter_name as string) ?? "renter",
      items: ((a.hygglo_items as Array<{ name: string }> | undefined) ?? []).map((h) => h.name),
      status: (a.status as string) ?? "",
      pickup_date: (first.pickup_date as string) ?? (first.start_date as string) ?? null,
      pickup_time: (first.pickup_time as string) ?? null,
      return_date: (latest.return_date as string) ?? (latest.end_date as string) ?? null,
      return_time: (latest.return_time as string) ?? null,
      pickup_address,
    };
  },
});

export const _listConfirmedThreads = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").withIndex("by_status", (q) => q.eq("status", "confirmed")).collect();
    return rows
      .filter((r) => !(r as { is_obsolete?: boolean }).is_obsolete)
      .map((r) => (r as { hygglo_order_id?: string }).hygglo_order_id)
      .filter((t): t is string => !!t);
  },
});

export const _getEventLinks = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) =>
    await ctx.db.query("calendar_event_links").withIndex("by_thread", (q) => q.eq("thread_id", thread_id)).collect(),
});

export const _getEventLinksForThreads = internalQuery({
  args: { thread_ids: v.array(v.string()) },
  handler: async (ctx, { thread_ids }) => {
    const out = [] as any[];
    for (const thread_id of thread_ids) out.push(...await ctx.db.query("calendar_event_links").withIndex("by_thread", (q) => q.eq("thread_id", thread_id)).collect());
    return out;
  },
});

export const _getAccountRoute = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) =>
    await ctx.db.query("calendar_account_routes").withIndex("by_account", (q) => q.eq("account_slug", account_slug)).first(),
});

export const _saveAccountRoutes = internalMutation({
  args: { routes: v.array(v.object({ account_slug: v.string(), calendar_name: v.string(), calendar_url: v.string() })) },
  handler: async (ctx, { routes }) => {
    for (const route of routes) {
      const existing = await ctx.db.query("calendar_account_routes").withIndex("by_account", (q) => q.eq("account_slug", route.account_slug)).first();
      const patch = { ...route, updated_at: Date.now() };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("calendar_account_routes", patch);
    }
  },
});

export const _saveEventLink = internalMutation({
  args: { thread_id: v.string(), kind: v.string(), event_uid: v.string(), event_href: v.string(), etag: v.optional(v.string()), ics_hash: v.string() },
  handler: async (ctx, a) => {
    const existing = await ctx.db.query("calendar_event_links").withIndex("by_uid", (q) => q.eq("event_uid", a.event_uid)).first();
    if (existing) await ctx.db.patch(existing._id, { ...a, synced_at: Date.now() });
    else await ctx.db.insert("calendar_event_links", { ...a, synced_at: Date.now() });
  },
});

export const _deleteEventLink = internalMutation({
  args: { id: v.id("calendar_event_links") },
  handler: async (ctx, { id }) => { await ctx.db.delete(id); },
});

/** Public status — never returns the app password. */
export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    const c = await ctx.db.query("calendar_connection").first();
    const links = await ctx.db.query("calendar_event_links").collect();
    if (!c) return { status: "disconnected", connected: false, events: 0 };
    return {
      status: c.status, connected: c.status === "connected", apple_id: c.apple_id ?? null,
      calendar_name: c.calendar_name ?? null, reminder_lead_min: c.reminder_lead_min ?? 60,
      return_reminder_lead_min: c.return_reminder_lead_min ?? c.reminder_lead_min ?? 60,
      auto_sync: c.auto_sync ?? false, last_error: c.last_error ?? null,
      last_sync_at: c.last_sync_at ?? null, connected_at: c.connected_at ?? null, events: links.length,
    };
  },
});

export const updateCalendarSettings = mutation({
  args: { reminder_lead_min: v.optional(v.number()), return_reminder_lead_min: v.optional(v.number()), auto_sync: v.optional(v.boolean()) },
  handler: async (ctx, patch) => {
    const row = await ctx.db.query("calendar_connection").first();
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    if (row) await ctx.db.patch(row._id, { ...clean, updated_at: Date.now() });
    else await ctx.db.insert("calendar_connection", { provider: "apple", status: "disconnected", ...clean, updated_at: Date.now() });
    return { ok: true };
  },
});
