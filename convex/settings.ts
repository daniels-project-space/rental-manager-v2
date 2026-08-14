import { action, mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  renderDiscountMessage,
  reviewOnlyMessageFor,
  reviewCommentFor,
} from "./lib/return_messages";
import { resolveReturnDiscount } from "./lib/return_discounts";

const MIN_POLLING_INTERVAL_MS = 2 * 60 * 1000;
const MAX_POLLING_INTERVAL_MS = 60 * 60 * 1000;
const DRAFT_TEXT_BLOCK_MAX_LENGTH = 2_000;

const DRAFT_TEXT_BLOCK_KEYS = [
  "opening",
  "availability",
  "location",
  "pickup_time",
  "payment",
] as const;

type DraftTextBlockKey = (typeof DRAFT_TEXT_BLOCK_KEYS)[number];
type DraftTextBlocks = Record<DraftTextBlockKey, string>;

function emptyDraftTextBlocks(): DraftTextBlocks {
  return {
    opening: "",
    availability: "",
    location: "",
    pickup_time: "",
    payment: "",
  };
}

function normalizeDraftTextBlocks(value: unknown): DraftTextBlocks {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const blocks = emptyDraftTextBlocks();
  for (const key of DRAFT_TEXT_BLOCK_KEYS) {
    if (typeof source[key] === "string") blocks[key] = source[key] as string;
  }
  return blocks;
}

function validatePickupHours(windows: Array<{ start: string; end: string }>) {
  if (windows.length > 8) throw new Error("Use at most eight pickup windows");
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const sorted = windows.map((window) => {
    if (!time.test(window.start) || !time.test(window.end)) {
      throw new Error("Pickup windows must use 24-hour HH:MM times");
    }
    const toMinutes = (value: string) => {
      const [hours, minutes] = value.split(":").map(Number);
      return hours * 60 + minutes;
    };
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    if (start >= end) throw new Error("Each pickup window must end after it starts");
    return { ...window, startMinutes: start, endMinutes: end };
  }).sort((a, b) => a.startMinutes - b.startMinutes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startMinutes < sorted[index - 1].endMinutes) {
      throw new Error("Pickup windows cannot overlap");
    }
  }
  return sorted.map(({ start, end }) => ({ start, end }));
}

// W01, W02, W20 — settings singleton row
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").first();
  },
});

/**
 * Update settings fields (partial).
 * SAFETY: automated renter-message sending is permanently disabled. The
 * legacy ALLOW_HYGGLO_SEND field may only be written false so old clients can
 * converge safely; no settings sequence can enable it.
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
    minimum_rental_gbp: v.optional(v.number()),
    draft_epoch: v.optional(v.number()),
  },
  handler: async (ctx, fields) => {
    if (fields.ALLOW_HYGGLO_SEND === true) {
      throw new Error(
        "SAFETY_RAIL: Automated renter-message sending is permanently disabled. Use Quick Reply and press Send yourself."
      );
    }
    const existing = await ctx.db.query("settings").first();
    if (!existing) throw new Error("No settings row found — seed the database first.");

    const patch: Record<string, unknown> = {};
    if (fields.read_only_mode !== undefined) patch.read_only_mode = fields.read_only_mode;
    if (fields.ALLOW_HYGGLO_SEND === false) patch.ALLOW_HYGGLO_SEND = false;
    if (fields.polling_interval_ms !== undefined) {
      if (
        !Number.isInteger(fields.polling_interval_ms) ||
        fields.polling_interval_ms < MIN_POLLING_INTERVAL_MS ||
        fields.polling_interval_ms > MAX_POLLING_INTERVAL_MS
      ) {
        throw new Error("Polling interval must be a whole number of milliseconds between 2 and 60 minutes");
      }
      patch.polling_interval_ms = fields.polling_interval_ms;
    }
    if (fields.escalate_to_sonnet !== undefined) patch.escalate_to_sonnet = fields.escalate_to_sonnet;
    if (fields.ai_boost_rate !== undefined) patch.ai_boost_rate = fields.ai_boost_rate;
    if (fields.ai_active_from !== undefined) patch.ai_active_from = fields.ai_active_from;
    if (fields.availability_include_pending !== undefined)
      patch.availability_include_pending = fields.availability_include_pending;
    if (fields.pickup_hours !== undefined) patch.pickup_hours = validatePickupHours(fields.pickup_hours);
    if (fields.minimum_rental_gbp !== undefined) patch.minimum_rental_gbp = fields.minimum_rental_gbp;
    if (fields.hub_heavy_max_km !== undefined) patch.hub_heavy_max_km = fields.hub_heavy_max_km;
    if (fields.hub_max_km !== undefined) patch.hub_max_km = fields.hub_max_km;
    if (fields.draft_epoch !== undefined) patch.draft_epoch = fields.draft_epoch;

    // WIRE-THROUGH: when a setting that feeds the AI draft / renter-facing bot
    // changes, bump draft_epoch so every CACHED draft is marked stale and
    // regenerates with the new setting (widgets read settings reactively already;
    // drafts are cached, so they need this nudge). Skip if the caller is itself
    // setting draft_epoch, or only changed poll/gate fields the draft ignores.
    const DRAFT_FIELDS: (keyof typeof fields)[] = [
      "pickup_hours",
      "escalate_to_sonnet",
      "availability_include_pending",
      "hub_max_km",
      "hub_heavy_max_km",
      "ai_boost_rate",
      "ai_active_from",
    ];
    if (fields.draft_epoch === undefined && DRAFT_FIELDS.some((f) => fields[f] !== undefined)) {
      patch.draft_epoch = ((existing as { draft_epoch?: number }).draft_epoch ?? 0) + 1;
    }

    await ctx.db.patch(existing._id, patch);
    return { ok: true, draft_epoch: patch.draft_epoch };
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
      pickup_address: string | null;
      pickup_hours: { start: string; end: string }[] | null;
      payment_info_text: string | null;
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
        pickup_address: profile?.pickup_address ?? null,
        pickup_hours: profile?.pickup_hours ?? null,
        payment_info_text: profile?.payment_info_text ?? null,
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

// ── Per-account automatic-draft communication controls ───────────────────

/**
 * The editable source of truth for the labelled wording blocks that are
 * injected into automatic renter drafts. Kept separate from Quick Reply
 * shortcuts: a shortcut is pasted by an operator, while these blocks guide
 * every future AI draft for the selected account.
 */
export const listAccountCommunication = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    const rows: Array<{
      account_id: Id<"accounts">;
      slug: string;
      display_name: string;
      pickup_address: string;
      pickup_hours: Array<{ start: string; end: string }>;
      draft_text_blocks: DraftTextBlocks;
    }> = [];
    for (const account of accounts) {
      if (account.slug === "dbcinema_web") continue;
      const profile = await ctx.db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", account._id))
        .first();
      rows.push({
        account_id: account._id,
        slug: account.slug,
        display_name: account.display_name ?? account.slug,
        pickup_address: profile?.pickup_address ?? "",
        pickup_hours: profile?.pickup_hours ?? [],
        draft_text_blocks: normalizeDraftTextBlocks(
          (profile as { draft_text_blocks?: unknown } | null)?.draft_text_blocks,
        ),
      });
    }
    return rows.sort((a, b) => a.slug.localeCompare(b.slug));
  },
});

/**
 * Atomically save one account's pickup facts plus its structured automatic
 * draft wording. The same transaction advances draft_epoch so cached drafts
 * cannot survive a wording change.
 */
export const setAccountCommunication = mutation({
  args: {
    account_id: v.id("accounts"),
    pickup_address: v.string(),
    pickup_hours: v.array(v.object({ start: v.string(), end: v.string() })),
    draft_text_blocks: v.object({
      opening: v.string(),
      availability: v.string(),
      location: v.string(),
      pickup_time: v.string(),
      payment: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.account_id);
    if (!account || account.slug === "dbcinema_web") {
      throw new Error("This account cannot receive renter-draft communication settings");
    }
    const pickupAddress = args.pickup_address.trim();
    if (pickupAddress.length > 500) throw new Error("Pickup address must be 500 characters or fewer");
    const pickupHours = validatePickupHours(args.pickup_hours);
    const draftTextBlocks = normalizeDraftTextBlocks(args.draft_text_blocks);
    for (const key of DRAFT_TEXT_BLOCK_KEYS) {
      draftTextBlocks[key] = draftTextBlocks[key].trim();
      if (draftTextBlocks[key].length > DRAFT_TEXT_BLOCK_MAX_LENGTH) {
        throw new Error(`${key.replace("_", " ")} wording must be ${DRAFT_TEXT_BLOCK_MAX_LENGTH} characters or fewer`);
      }
    }

    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", args.account_id))
      .first();
    const now = Date.now();
    const fields = {
      pickup_address: pickupAddress,
      pickup_hours: pickupHours,
      draft_text_blocks: draftTextBlocks,
      updated_at: now,
    };
    if (profile) await ctx.db.patch(profile._id, fields);
    else {
      await ctx.db.insert("account_profiles", {
        account_id: args.account_id,
        ...fields,
        created_at: now,
      });
    }

    const settings = await ctx.db.query("settings").first();
    if (settings) {
      await ctx.db.patch(settings._id, {
        draft_epoch: ((settings as { draft_epoch?: number }).draft_epoch ?? 0) + 1,
      });
    }
    return { ok: true, account_slug: account.slug, pickup_hours: pickupHours };
  },
});

// ── Per-account post-return discount code + message previews ──────────────

/**
 * Every Hygglo account's EFFECTIVE return-discount config (saved value or
 * default) plus the exact texts that would go out — so the Settings drawer
 * and the Return Hub overlay always show what markReturned will really send.
 */
export const listReturnDiscounts = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    const out: {
      account_id: Id<"accounts">;
      slug: string;
      display_name: string;
      code: string;
      percent: number;
      preview_discount: string;
      preview_review_only: string | null;
      preview_review_comment: string;
    }[] = [];
    for (const a of accounts) {
      if (a.slug === "dbcinema_web") continue; // storefront, no Hygglo chat
      const d = await resolveReturnDiscount(ctx.db, a.slug);
      if (!d) continue;
      const preview = renderDiscountMessage(a.slug, d.code, d.percent);
      if (!preview) continue; // account has no message template
      out.push({
        account_id: a._id,
        slug: a.slug,
        display_name: a.display_name ?? a.slug,
        code: d.code,
        percent: d.percent,
        preview_discount: preview,
        preview_review_only: reviewOnlyMessageFor(a.slug),
        preview_review_comment: reviewCommentFor(a.slug),
      });
    }
    out.sort((x, y) => x.slug.localeCompare(y.slug));
    return out;
  },
});

/** Save an account's discount code + percent (drives all future return texts). */
export const setReturnDiscount = mutation({
  args: {
    account_id: v.id("accounts"),
    code: v.string(),
    percent: v.number(),
  },
  handler: async (ctx, { account_id, code, percent }) => {
    const clean = code.trim().toUpperCase().replace(/\s+/g, "");
    if (!clean) throw new Error("Discount code can't be empty");
    if (!Number.isFinite(percent) || percent < 1 || percent > 90) {
      throw new Error("Percent must be between 1 and 90");
    }
    const rounded = Math.round(percent);
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account_id))
      .first();
    const now = Date.now();
    if (profile) {
      await ctx.db.patch(profile._id, {
        return_discount_code: clean,
        return_discount_percent: rounded,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("account_profiles", {
        account_id,
        return_discount_code: clean,
        return_discount_percent: rounded,
        created_at: now,
        updated_at: now,
      });
    }
    return { ok: true, code: clean, percent: rounded };
  },
});


/** Set (or update) the per-account PICKUP address, shown in Settings. */
export const setAccountPickupAddress = mutation({
  args: { account_slug: v.string(), pickup_address: v.string() },
  handler: async (ctx, { account_slug, pickup_address }) => {
    const accts = await ctx.db.query("accounts").collect();
    const acct = accts.find((a) => a.slug === account_slug);
    if (!acct) throw new Error(`No account "${account_slug}"`);
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", acct._id))
      .first();
    if (!profile) throw new Error(`No profile for "${account_slug}"`);
    await ctx.db.patch(profile._id, { pickup_address });
    return { ok: true, account_slug, pickup_address };
  },
});


/** Set (or update) the per-account PAYMENT info text, shown in Settings. */
export const setAccountPaymentInfo = mutation({
  args: { account_slug: v.string(), payment_info_text: v.string() },
  handler: async (ctx, { account_slug, payment_info_text }) => {
    const accts = await ctx.db.query("accounts").collect();
    const acct = accts.find((a) => a.slug === account_slug);
    if (!acct) throw new Error(`No account "${account_slug}"`);
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", acct._id))
      .first();
    if (!profile) throw new Error(`No profile for "${account_slug}"`);
    await ctx.db.patch(profile._id, { payment_info_text });
    return { ok: true, account_slug, payment_info_text };
  },
});


/** Set the per-account pickup/return windows (shown in Settings). */
export const setAccountPickupHours = mutation({
  args: {
    account_slug: v.string(),
    pickup_hours: v.array(v.object({ start: v.string(), end: v.string() })),
  },
  handler: async (ctx, { account_slug, pickup_hours }) => {
    const accts = await ctx.db.query("accounts").collect();
    const acct = accts.find((a) => a.slug === account_slug);
    if (!acct) throw new Error(`No account "${account_slug}"`);
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", acct._id))
      .first();
    if (!profile) throw new Error(`No profile for "${account_slug}"`);
    await ctx.db.patch(profile._id, { pickup_hours });
    return { ok: true, account_slug, pickup_hours };
  },
});
