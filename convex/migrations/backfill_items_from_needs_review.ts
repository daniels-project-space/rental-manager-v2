/**
 * Backfill items table from listing_info_pool needs_review triage (2026-05-24).
 *
 * Eight Hygglo listings were flagged needs_review because the LLM-derived
 * bundle_components couldn't fuzzy-match against the items inventory. Each
 * entry below is a real, distinct product Daniel rents but that wasn't yet
 * in the items master list. Adding these unblocks per-item attribution,
 * double-booking detection, and out-of-stock signals for the affected
 * listings.
 *
 * Idempotent: addItemIfMissing skips inserts when name_canonical already
 * exists, so running this migration repeatedly is safe.
 *
 * Triggered listings (account_slug / product_id):
 *   Pioneer XDJ-RX2          — dbcinema/1103086, dbcinema/1103102
 *   DJI Fly More Kit         — leo/1116290
 *   DZOFilm Vespid 3-Lens Set — leo/1114664
 *   Manfrotto 190X Tripod    — dbcinema/1103082
 *   ViewSonic 4K Projector   — dbcinema/1103081
 *   MACKIE Thump Go speaker  — dbcinema/997640
 *   Atomos 1TB SSD           — dbcinema/1011618
 *   Sennheiser MKE 600       — leo/1112133, dbcinema/811244
 *
 * Run order (executed manually 2026-05-24 against hearty-oyster-600):
 *   1. npx convex run migrations/backfill_items_from_needs_review:run '{}'
 *   2. for each affected (slug, pid):
 *        npx convex run listing_info_pool:forceReDerive ...
 *        npx convex run listing_info_pool_actions:deriveOne ... (force=true)
 */
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

type NewItem = {
  canonical_name: string;
  kind: string;
  unit_kind: string;
};

const NEW_ITEMS: NewItem[] = [
  { canonical_name: "Pioneer XDJ-RX2",          kind: "dj_audio",     unit_kind: "unit" },
  { canonical_name: "DJI Fly More Kit",         kind: "accessory",    unit_kind: "kit" },
  { canonical_name: "DZOFilm Vespid 3-Lens Set", kind: "lens",         unit_kind: "set" },
  { canonical_name: "Manfrotto 190X Tripod",    kind: "support",      unit_kind: "unit" },
  { canonical_name: "ViewSonic 4K Projector",   kind: "video",        unit_kind: "unit" },
  { canonical_name: "MACKIE Thump Go speaker",  kind: "dj_audio",     unit_kind: "unit" },
  { canonical_name: "Atomos 1TB SSD",           kind: "storage_card", unit_kind: "unit" },
  { canonical_name: "Sennheiser MKE 600",       kind: "audio",        unit_kind: "unit" },
];

export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ inserted: number; existed: number; rows: Array<{ name: string; action: string }> }> => {
    let inserted = 0;
    let existed = 0;
    const rows: Array<{ name: string; action: string }> = [];
    for (const it of NEW_ITEMS) {
      const res: { action: "inserted" | "exists"; item_id: unknown; canonical: string } =
        await ctx.runMutation(internal.admin_item_attribution.addItemIfMissing, {
          canonical_name: it.canonical_name,
          name_input: it.canonical_name,
          kind: it.kind,
          qty: 1,
          unit_kind: it.unit_kind,
        });
      if (res.action === "inserted") inserted++;
      else existed++;
      rows.push({ name: it.canonical_name, action: res.action });
    }
    return { inserted, existed, rows };
  },
});
