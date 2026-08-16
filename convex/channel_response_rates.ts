/**
 * Cached official Hygglo profile response rates for the dashboard speedometers.
 *
 * Hygglo exposes this account-level statistic beneath the profile image and in
 * the public profile payload as `responseRatePercentage`. It is the platform's
 * own recent-request calculation, so we deliberately do not reconstruct it
 * from the app's partial inbox history.
 */
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { ACCOUNTS } from "./mv/constants";

const SNAPSHOT_KEY = "all";

const HYGGLO_PROFILE_URLS: Partial<Record<(typeof ACCOUNTS)[number], string>> = {
  dbcinema: "https://hygglo.com/users/dbcinemarentals",
  leo: "https://hygglo.com/uk/users/9hKWNougU-leo",
  diogo: "https://hygglo.com/uk/users/XWs4CO2r8-diogo",
  // This is the direct website channel, not a Hygglo vendor profile.
  dbcinema_web: undefined,
};

type ChannelRate = {
  slug: string;
  rate: number | null;
  source: "hygglo_profile" | "not_available";
};

type SnapshotPayload = { channels: ChannelRate[] };

/** Extract a 0–100 Hygglo profile statistic without retaining profile data. */
export function extractHyggloResponseRate(page: string): number | null {
  const match = page.match(/\b(\d{1,3})%\s*response rate\b/i);
  if (!match) return null;
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100
    ? percentage / 100
    : null;
}

function profileChannels(rates: Partial<Record<(typeof ACCOUNTS)[number], number | null>>): ChannelRate[] {
  return ACCOUNTS.map((slug) => {
    const isHyggloProfile = Boolean(HYGGLO_PROFILE_URLS[slug]);
    return {
      slug,
      rate: isHyggloProfile ? (rates[slug] ?? null) : null,
      source: isHyggloProfile ? "hygglo_profile" : "not_available",
    };
  });
}

async function fetchProfileRate(url: string): Promise<number | null> {
  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": "RentalManager/1.0 (+https://rental-manager-v2-nu.vercel.app)" },
  });
  if (!response.ok) return null;
  return extractHyggloResponseRate(await response.text());
}

// The committed generated API intentionally lags newly added Convex modules.
const writeRef = makeFunctionReference<"mutation">("channel_response_rates:write");

/** Scheduled at 08:00 and 20:00 UTC from convex/crons.ts. */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; channels: number; generatedAt: number }> => {
    const generatedAt = Date.now();
    const entries = Object.entries(HYGGLO_PROFILE_URLS).filter(
      (entry): entry is [(typeof ACCOUNTS)[number], string] => Boolean(entry[1]),
    );
    const fetched = await Promise.all(entries.map(async ([slug, url]) => [slug, await fetchProfileRate(url)] as const));
    const snapshot: SnapshotPayload = { channels: profileChannels(Object.fromEntries(fetched)) };
    await ctx.runMutation(writeRef, { ...snapshot, generatedAt });
    return { ok: true, channels: snapshot.channels.length, generatedAt };
  },
});

/** Upsert the singleton snapshot. The timestamp is always updated on schedule. */
export const write = internalMutation({
  args: {
    generatedAt: v.number(),
    channels: v.array(v.object({
      slug: v.string(),
      rate: v.union(v.number(), v.null()),
      source: v.union(v.literal("hygglo_profile"), v.literal("not_available")),
    })),
  },
  handler: async (ctx, { generatedAt, channels }) => {
    const existing = await ctx.db
      .query("mv_channel_response_rates")
      .withIndex("by_key", (q) => q.eq("key", SNAPSHOT_KEY))
      .first();
    const payload = { generatedAt, channels };
    if (existing) await ctx.db.patch(existing._id, payload);
    else await ctx.db.insert("mv_channel_response_rates", { key: SNAPSHOT_KEY, ...payload });
    return { ok: true };
  },
});

/** Lightweight reader used by the dashboard card. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("mv_channel_response_rates")
      .withIndex("by_key", (q) => q.eq("key", SNAPSHOT_KEY))
      .first();
  },
});
