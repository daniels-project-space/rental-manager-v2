/**
 * Wave 2 — renter-profile + blacklist read queries.
 * Wraps the existing `renters` table (Phase 2.A v1-imported rows).
 *
 * Mastra surfaces:
 *   - data.renters.getProfile     → renters.getByName
 *   - data.renters.checkBlacklist → renters.checkBlacklistByName
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find a renter profile by display_name (fuzzy substring on normalised text).
 * Returns most-recent-active match or null.
 */
export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const target = norm(name);
    if (target.length < 2) return null;
    const rows = await ctx.db.query("renters").collect();
    let best:
      | (typeof rows)[number]
      | null = null;
    for (const r of rows) {
      const dn = r.display_name ?? "";
      const dnNorm = norm(dn);
      if (!dnNorm) continue;
      if (dnNorm === target || dnNorm.includes(target) || target.includes(dnNorm)) {
        if (
          !best ||
          (r.last_rental_at ?? 0) > (best.last_rental_at ?? 0)
        ) {
          best = r;
        }
      }
    }
    if (!best) return null;
    return {
      id: best._id,
      displayName: best.display_name ?? null,
      hyggloUserId: best.hygglo_user_id ?? null,
      email: best.email ?? null,
      phone: best.phone ?? null,
      hyggloRating: best.hygglo_rating ?? null,
      hyggloReviewCount: best.hygglo_review_count ?? null,
      totalRentalsCount: best.total_rentals_count ?? 0,
      totalSpendGbp: best.total_spend_gbp ?? 0,
      firstRentalAt: best.first_rental_at ?? null,
      lastRentalAt: best.last_rental_at ?? null,
      blacklisted: best.blacklisted ?? best.blacklist ?? false,
      blacklistReason: best.blacklist_reason ?? null,
      notes: best.notes ?? null,
    };
  },
});

/**
 * Boolean blacklist lookup by name. Returns the matching renter row's
 * blacklist fields, or `{ blacklisted: false }` when no match.
 */
export const checkBlacklistByName = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const target = norm(name);
    if (target.length < 2) return { blacklisted: false };
    const rows = await ctx.db.query("renters").collect();
    for (const r of rows) {
      const dn = r.display_name ?? "";
      const dnNorm = norm(dn);
      if (!dnNorm) continue;
      if (dnNorm === target || dnNorm.includes(target) || target.includes(dnNorm)) {
        const flagged = r.blacklisted ?? r.blacklist ?? false;
        if (flagged) {
          return {
            blacklisted: true,
            renterId: r._id,
            displayName: r.display_name ?? null,
            reason: r.blacklist_reason ?? null,
            hyggloUserId: r.hygglo_user_id ?? null,
          };
        }
      }
    }
    return { blacklisted: false };
  },
});
