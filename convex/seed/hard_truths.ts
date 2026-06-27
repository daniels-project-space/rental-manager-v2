/**
 * One-off seed: give every account_profiles row a starter `hard_truths` (the
 * ground-truth block injected verbatim at the end of the draft prompt). Universal
 * gear facts only — edit per account later for model-specific truths (battery
 * families, base-kit contents). Idempotent: skips rows that already have one.
 */
import { internalMutation } from "../_generated/server";

const DEFAULT_HARD_TRUTHS =
  "SD cards, batteries, chargers, cables and straps are INCLUDED free with every " +
  "camera and lens rental — never quote them as separate paid items. Only ever " +
  "offer gear that's actually in my inventory; if nothing fits, say everything's " +
  "booked rather than naming a model I don't have. Listing titles sometimes say " +
  "'like a [model]' or 'same sensor as [model]' — those are marketing comparisons, " +
  "NOT gear I stock, so never suggest an item just because it appears after 'like'. " +
  "Pickup and return happen in person at the agreed time; I arrange the handoff myself.";

export const seedHardTruths = internalMutation({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("account_profiles").collect();
    let updated = 0;
    for (const p of profiles) {
      if (p.hard_truths && p.hard_truths.trim()) continue;
      await ctx.db.patch(p._id, {
        hard_truths: DEFAULT_HARD_TRUTHS,
        updated_at: Date.now(),
      });
      updated++;
    }
    return { profiles: profiles.length, updated };
  },
});
