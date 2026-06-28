import { action, mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// W01, W02, W20 — settings singleton row
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").first();
  },
});

/**
 * Update settings fields (partial).
 * SAFETY: throws if caller attempts to set both read_only_mode=false AND ALLOW_HYGGLO_SEND=true
 * in a single mutation — the double-unlock is unconditionally rejected.
 */
export const update = mutation({
  args: {
    read_only_mode: v.optional(v.boolean()),
    ALLOW_HYGGLO_SEND: v.optional(v.boolean()),
    polling_interval_ms: v.optional(v.number()),
    escalate_to_sonnet: v.optional(v.boolean()),
    ai_boost_rate: v.optional(v.number()),
    ai_active_from: v.optional(v.string()),
    availability_include_pending: v.optional(v.boolean()),
    pickup_hours: v.optional(
      v.array(v.object({ start: v.string(), end: v.string() })),
    ),
    hub_heavy_max_km: v.optional(v.number()),
    hub_max_km: v.optional(v.number()),
    draft_epoch: v.optional(v.number()),
  },
  handler: async (ctx, fields) => {
    // Double-unlock guard: refuse read_only_mode=false + ALLOW_HYGGLO_SEND=true together
    if (fields.read_only_mode === false && fields.ALLOW_HYGGLO_SEND === true) {
      throw new Error(
        "SAFETY_RAIL: Cannot disable read_only_mode and enable ALLOW_HYGGLO_SEND in one mutation."
      );
    }
    const existing = await ctx.db.query("settings").first();
    if (!existing) throw new Error("No settings row found — seed the database first.");

    const patch: Record<string, unknown> = {};
    if (fields.read_only_mode !== undefined) patch.read_only_mode = fields.read_only_mode;
    if (fields.ALLOW_HYGGLO_SEND !== undefined) patch.ALLOW_HYGGLO_SEND = fields.ALLOW_HYGGLO_SEND;
    if (fields.polling_interval_ms !== undefined) patch.polling_interval_ms = fields.polling_interval_ms;
    if (fields.escalate_to_sonnet !== undefined) patch.escalate_to_sonnet = fields.escalate_to_sonnet;
    if (fields.ai_boost_rate !== undefined) patch.ai_boost_rate = fields.ai_boost_rate;
    if (fields.ai_active_from !== undefined) patch.ai_active_from = fields.ai_active_from;
    if (fields.availability_include_pending !== undefined)
      patch.availability_include_pending = fields.availability_include_pending;
    if (fields.pickup_hours !== undefined) patch.pickup_hours = fields.pickup_hours;
    if (fields.hub_heavy_max_km !== undefined) patch.hub_heavy_max_km = fields.hub_heavy_max_km;
    if (fields.hub_max_km !== undefined) patch.hub_max_km = fields.hub_max_km;
    if (fields.draft_epoch !== undefined) patch.draft_epoch = fields.draft_epoch;

    await ctx.db.patch(existing._id, patch);
    return { ok: true };
  },
});

// ── Per-account rental hub (geocoded via postcodes.io — the register) ──

/** Every draft account (excludes dbcinema_web) + its confirmed hub. */
export const listAccountHubs = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    const out: {
      account_id: Id<"accounts">;
      slug: string;
      display_name: string;
      hub_postcode: string | null;
      hub_label: string | null;
    }[] = [];
    for (const a of accounts) {
      if (a.slug === "dbcinema_web") continue;
      const profile = await ctx.db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", a._id))
        .first();
      out.push({
        account_id: a._id,
        slug: a.slug,
        display_name: a.display_name ?? a.slug,
        hub_postcode: profile?.hub_postcode ?? null,
        hub_label: profile?.hub_label ?? null,
      });
    }
    out.sort((x, y) => x.slug.localeCompare(y.slug));
    return out;
  },
});

/** Confirm a postcode against postcodes.io and store it as THIS account's hub.
 *  Returns the matched admin district as proof. */
export const setHub = action({
  args: { account_id: v.id("accounts"), postcode: v.string() },
  handler: async (
    ctx,
    { account_id, postcode },
  ): Promise<{ ok: boolean; reason?: string; label?: string; postcode?: string }> => {
    const pc = postcode.replace(/\s+/g, "").toUpperCase();
    if (pc.length < 5) return { ok: false, reason: "Enter a full UK postcode" };
    let res: Record<string, any> | undefined;
    try {
      const r = await fetch(
        `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`,
      );
      if (!r.ok) return { ok: false, reason: "We couldn't find that postcode" };
      res = (await r.json())?.result;
    } catch {
      return { ok: false, reason: "Lookup failed — try again" };
    }
    if (!res || typeof res.latitude !== "number")
      return { ok: false, reason: "We couldn't find that postcode" };
    const label =
      [res.admin_ward, res.admin_district].filter(Boolean).join(", ") ||
      res.admin_district ||
      res.parish ||
      pc;
    await ctx.runMutation(internal.settings.applyAccountHub, {
      account_id,
      postcode: res.postcode ?? pc,
      label,
      lat: res.latitude,
      lng: res.longitude,
    });
    return { ok: true, label, postcode: res.postcode ?? pc };
  },
});

export const applyAccountHub = internalMutation({
  args: {
    account_id: v.id("accounts"),
    postcode: v.string(),
    label: v.string(),
    lat: v.number(),
    lng: v.number(),
  },
  handler: async (ctx, { account_id, postcode, label, lat, lng }) => {
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account_id))
      .first();
    const now = Date.now();
    const fields = { hub_postcode: postcode, hub_label: label, hub_lat: lat, hub_lng: lng };
    if (profile) await ctx.db.patch(profile._id, { ...fields, updated_at: now });
    else
      await ctx.db.insert("account_profiles", {
        account_id,
        ...fields,
        created_at: now,
        updated_at: now,
      });
    return { ok: true };
  },
});

// ── Per-account AI "hard truths" (account_profiles.hard_truths) ───
// Owner-editable ground-truth injected verbatim at the end of every AI draft
// for that account. Edited from the Settings drawer.

/** All draft accounts (excludes the dbcinema_web storefront) + their hard_truths. */
export const listAccountHardTruths = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    const out: {
      account_id: Id<"accounts">;
      slug: string;
      display_name: string;
      hard_truths: string;
    }[] = [];
    for (const a of accounts) {
      if (a.slug === "dbcinema_web") continue; // storefront, not a draft account
      const profile = await ctx.db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", a._id))
        .first();
      out.push({
        account_id: a._id,
        slug: a.slug,
        display_name: a.display_name ?? a.slug,
        hard_truths: profile?.hard_truths ?? "",
      });
    }
    out.sort((x, y) => x.slug.localeCompare(y.slug));
    return out;
  },
});

export const setAccountHardTruths = mutation({
  args: { account_id: v.id("accounts"), hard_truths: v.string() },
  handler: async (ctx, { account_id, hard_truths }) => {
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account_id))
      .first();
    const now = Date.now();
    if (profile) {
      await ctx.db.patch(profile._id, { hard_truths, updated_at: now });
    } else {
      await ctx.db.insert("account_profiles", {
        account_id,
        hard_truths,
        created_at: now,
        updated_at: now,
      });
    }
    return { ok: true };
  },
});

