import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { DEFAULT_HARD_TRUTHS, LEGACY_HARD_TRUTHS } from "./hard_truths";

const faqCorrections = [
  {
    "title": "FAQ: BMPCC Battery Life",
    "before": "Real-world ~40-50 min per LP-E6NH battery. Kit includes 5× LP-E6NH plus charger. Recommend USB-C wall power for long takes.",
    "after": "The owned Blackmagic 6K Pro and Cinema Camera 6K Full Frame kits use native NP-F570 batteries. Use the selected inventory kit for supplied counts and accessories; battery runtime and external-power compatibility require verified exact-model specifications, not a generic BMPCC assumption."
  },
  {
    "title": "FAQ: BMPCC 6K Full Frame Storage",
    "before": "This kit does NOT include an SSD — that's the 6K Pro variant only. The Full Frame kit is a Canon EF-to-L mount adapter + 5× LP-E6NH batteries plus charger. Answer confidently from these two facts; there is nothing else confirmed in this kit.",
    "after": "The Blackmagic Cinema Camera 6K Full Frame kit supplies a 1TB CFexpress Type B card and native NP-F570 batteries. Use the current selected kit inventory for battery counts, adapters and other accessories. External USB-C storage support is a capability, not proof an SSD is supplied. Unrecorded accessories need checking; do not assert they are included or excluded."
  }
];

/** Compare exact seed text before repair. Owner edits are never overwritten. */
export const repairLegacyKitSources = internalMutation({
  args: { apply: v.boolean() },
  handler: async (ctx, { apply }) => {
    const profiles = await ctx.db.query("account_profiles").collect();
    const memories = await ctx.db.query("memories").collect();
    const matchedProfiles = profiles.filter(p => p.hard_truths === LEGACY_HARD_TRUTHS);
    const matchedMemories = memories.flatMap(m => {
      const fix = faqCorrections.find(f => f.title === m.title && f.before === m.content);
      return fix ? [{ row: m, fix }] : [];
    });
    if (apply) {
      for (const p of matchedProfiles) await ctx.db.patch(p._id, { hard_truths: DEFAULT_HARD_TRUTHS, updated_at: Date.now() });
      for (const { row, fix } of matchedMemories) await ctx.db.patch(row._id, { content: fix.after, updated_at: Date.now() });
      // Cached drafts/review holds were based on superseded source facts.
      if (matchedProfiles.length || matchedMemories.length) {
        const settings = await ctx.db.query("settings").first();
        if (settings) await ctx.db.patch(settings._id, { draft_epoch: (settings.draft_epoch ?? 0) + 1 });
      }
    }
    return { applied: apply, profiles: matchedProfiles.length, memories: matchedMemories.map(m => m.row.title) };
  },
});
