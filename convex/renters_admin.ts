/**
 * Renter CRM admin — CLI surface for the owner. All public so they're callable
 * via `npx convex run renters_admin:<fn> '{...}'`.
 *
 *   find      — search renters by name (disambiguate before acting)
 *   profile   — full trust profile + recent rentals for one renter
 *   setBlacklist / setWhitelist — toggle trust flags (+ reason)
 *   addNote   — append a timestamped owner note (the "notes via CLI")
 *   listFlagged — every blacklisted / whitelisted renter
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { resolveRenter, trustOf, type RenterDoc } from "./lib/renters";

const summarize = (r: RenterDoc) => ({
  id: r._id as string,
  name: r.display_name ?? "(no name)",
  hygglo_user_id: r.hygglo_user_id ?? null,
  ...trustOf(r),
  note_log: (r.note_log ?? []).map((n) => ({ text: n.text, at: n.at, source: n.source ?? null })),
});

export const find = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const low = q.trim().toLowerCase();
    if (!low) return { matches: [] };
    const all = await ctx.db.query("renters").collect();
    const matches = all
      .filter((r) => (r.display_name ?? "").toLowerCase().includes(low))
      .sort((a, b) => (b.total_rentals_count ?? 0) - (a.total_rentals_count ?? 0))
      .slice(0, 25)
      .map((r) => ({
        id: r._id as string,
        name: r.display_name ?? "(no name)",
        rentals: r.total_rentals_count ?? 0,
        blacklisted: !!(r.blacklisted || r.blacklist),
        whitelisted: !!r.whitelisted,
      }));
    return { count: matches.length, matches };
  },
});

export const profile = query({
  args: { renter: v.string() },
  handler: async (ctx, { renter }) => {
    const res = await resolveRenter(ctx, renter);
    if ("notfound" in res) return { error: "not found" };
    if ("ambiguous" in res)
      return { error: "ambiguous", matches: res.ambiguous.map((r) => ({ id: r._id as string, name: r.display_name })) };
    const r = res.renter;
    // recent rentals for context
    const rentals = (await ctx.db.query("reservations").collect())
      .filter(
        (x) =>
          (r.hygglo_user_id && x.hygglo_user_id === r.hygglo_user_id) ||
          (x.renter_id && x.renter_id === (r._id as string)) ||
          (x.renter_name ?? "").trim().toLowerCase() === (r.display_name ?? "").trim().toLowerCase(),
      )
      .sort((a, b) => String(b.start_date ?? "").localeCompare(String(a.start_date ?? "")))
      .slice(0, 8)
      .map((x) => ({
        order: x.hygglo_order_id ?? null,
        dates: `${x.start_date ?? "?"}→${x.end_date ?? "?"}`,
        step: x.order_step ?? null,
        status: x.status,
        items: (x.items ?? []).map((i) => i.item_name).slice(0, 3),
      }));
    return { renter: summarize(r), recent_rentals: rentals };
  },
});

export const listFlagged = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("renters").collect();
    return {
      blacklisted: all.filter((r) => r.blacklisted || r.blacklist).map(summarize),
      whitelisted: all.filter((r) => r.whitelisted).map(summarize),
    };
  },
});

export const setBlacklist = mutation({
  args: { renter: v.string(), on: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { renter, on, reason }) => {
    const res = await resolveRenter(ctx, renter);
    if ("notfound" in res) return { ok: false, error: "not found" };
    if ("ambiguous" in res)
      return { ok: false, error: "ambiguous — pass an id", matches: res.ambiguous.map((r) => ({ id: r._id, name: r.display_name })) };
    const r = res.renter;
    const log = [...(r.note_log ?? [])];
    log.push({ text: on ? `BLACKLISTED${reason ? ": " + reason : ""}` : "Blacklist removed", at: Date.now(), source: "cli" });
    await ctx.db.patch(r._id, {
      blacklisted: on,
      blacklist: on,
      blacklist_reason: on ? reason ?? r.blacklist_reason : undefined,
      blacklisted_at: on ? Date.now() : undefined,
      note_log: log,
    });
    return { ok: true, renter: r.display_name, blacklisted: on, reason: on ? reason ?? null : null };
  },
});

export const setWhitelist = mutation({
  args: { renter: v.string(), on: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { renter, on, reason }) => {
    const res = await resolveRenter(ctx, renter);
    if ("notfound" in res) return { ok: false, error: "not found" };
    if ("ambiguous" in res)
      return { ok: false, error: "ambiguous — pass an id", matches: res.ambiguous.map((r) => ({ id: r._id, name: r.display_name })) };
    const r = res.renter;
    const log = [...(r.note_log ?? [])];
    log.push({ text: on ? `WHITELISTED${reason ? ": " + reason : ""}` : "Whitelist removed", at: Date.now(), source: "cli" });
    await ctx.db.patch(r._id, {
      whitelisted: on,
      whitelist_reason: on ? reason ?? r.whitelist_reason : undefined,
      whitelisted_at: on ? Date.now() : undefined,
      note_log: log,
    });
    return { ok: true, renter: r.display_name, whitelisted: on };
  },
});

export const addNote = mutation({
  args: { renter: v.string(), note: v.string() },
  handler: async (ctx, { renter, note }) => {
    const res = await resolveRenter(ctx, renter);
    if ("notfound" in res) return { ok: false, error: "not found" };
    if ("ambiguous" in res)
      return { ok: false, error: "ambiguous — pass an id", matches: res.ambiguous.map((r) => ({ id: r._id, name: r.display_name })) };
    const r = res.renter;
    const log = [...(r.note_log ?? []), { text: note, at: Date.now(), source: "cli" }];
    await ctx.db.patch(r._id, { note_log: log });
    return { ok: true, renter: r.display_name, note_count: log.length };
  },
});
