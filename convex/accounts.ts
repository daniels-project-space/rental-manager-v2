/**
 * Account meta — slug, display_name, and Hygglo profile image.
 * The dashboard reads this to render real avatars (vs hardcoded text "DB"/"Leo").
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("accounts").collect();
    return rows.map((a) => ({
      slug: a.slug,
      display_name: a.display_name,
      profile_image_url: (a as { profile_image_url?: string }).profile_image_url ?? null,
    }));
  },
});

/** One-shot seed of profile images scraped from Hygglo /v4/my/orders detail. */
export const setProfileImage = mutation({
  args: { slug: v.string(), profile_image_url: v.string() },
  handler: async (ctx, { slug, profile_image_url }) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { profile_image_url, updated_at: Date.now() });
      return { action: "updated", id: existing._id };
    }
    const id = await ctx.db.insert("accounts", {
      slug,
      display_name: slug,
      profile_image_url,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return { action: "inserted", id };
  },
});
