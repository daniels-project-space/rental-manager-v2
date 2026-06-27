/**
 * One-off migration: copy the legacy GLOBAL settings hub (settings.hub_*) onto
 * each account_profiles row that has no per-account hub yet, so tiles keep
 * showing distances after the move to per-account hubs. The owner then edits
 * each account's real hub in Settings. Idempotent.
 */
import { internalMutation } from "../_generated/server";

export const seedAccountHubs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.db.query("settings").first();
    if (!s?.hub_lat || !s?.hub_lng) return { ok: false, reason: "no global hub set" };
    const profiles = await ctx.db.query("account_profiles").collect();
    let updated = 0;
    for (const p of profiles) {
      if (p.hub_lat != null) continue;
      await ctx.db.patch(p._id, {
        hub_postcode: s.hub_postcode,
        hub_label: s.hub_label,
        hub_lat: s.hub_lat,
        hub_lng: s.hub_lng,
        updated_at: Date.now(),
      });
      updated++;
    }
    return { ok: true, updated };
  },
});
