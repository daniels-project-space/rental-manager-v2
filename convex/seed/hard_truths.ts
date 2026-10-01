/**
 * One-off seed: give every account_profiles row a starter `hard_truths` (the
 * ground-truth block injected verbatim at the end of the draft prompt). Universal
 * source precedence and handoff rules only — exact kit facts come from
 * inventory records. Owner-edited profiles are preserved. Idempotent: skips rows that already have one.
 */
import { internalMutation } from "../_generated/server";

export const LEGACY_HARD_TRUTHS =
  "SD cards, batteries, chargers, cables and straps are INCLUDED free with every " +
  "camera and lens rental — never quote them as separate paid items. Only ever " +
  "offer gear that's actually in my inventory; if nothing fits, say everything's " +
  "booked rather than naming a model I don't have. Listing titles sometimes say " +
  "'like a [model]' or 'same sensor as [model]' — those are marketing comparisons, " +
  "NOT gear I stock, so never suggest an item just because it appears after 'like'. " +
  "Pickup and return happen in person at the agreed time; I arrange the handoff myself.";

export const DEFAULT_HARD_TRUTHS =
  "Included accessories are free with the rental when recorded in the selected kit's inventory; never quote those recorded inclusions as separate paid items. " +
  "Do not promise every camera or lens includes an SD card, battery, charger, cable or strap. Exact accessory types, counts and capacities come from the selected kit records. " +
  "Only offer owned rentable inventory. If nothing meets the request, explain that no suitable owned option is established; say booked only when a stock check proves it for the requested dates and quantity. " +
  "Listing titles and descriptions are advertising, not proof of ownership, specifications or kit contents. Models after 'like' are comparisons, not stock. " +
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
