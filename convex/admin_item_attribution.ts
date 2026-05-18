/**
 * Phase 1.5a — Admin mutations for hydrating item attribution metadata.
 *
 * Three mutations:
 *   - setItemAttribution: patch a single item by canonical name
 *   - bulkSetItemAttribution: patch many items in one mutation
 *   - correctMisclassifiedKinds: fixes the 10 seed-bug rows (idempotent)
 *
 * All three:
 *   - Read-then-write (no-op when state already correct)
 *   - Idempotent (re-runnable without duplicating writes)
 *   - Log every mutation to audit_log
 *   - Return a structured summary
 *
 * Run from CLI (after seed):
 *   npx convex run --prod admin_item_attribution:correctMisclassifiedKinds
 *   npx convex run --prod admin_item_attribution:bulkSetItemAttribution "$(cat /tmp/item_attribution_template.json)"
 */

import { mutation } from "./_generated/server";
import { v } from "convex/values";

const ACTOR_SEED = "phase-1.5a";

/**
 * Single-item attribution setter. Patches `replacement_cost_gbp` and/or
 * `compatibility.included_with_rental` and/or `kind` on the item whose
 * `name_canonical` matches the argument.
 *
 * Returns `{ updated: 0|1, not_found: 0|1, no_op: 0|1 }`.
 */
export const setItemAttribution = mutation({
  args: {
    canonical_name: v.string(),
    replacement_cost_gbp: v.optional(v.number()),
    included_with_rental: v.optional(v.array(v.string())),
    kind_override: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) =>
        q.eq("name_canonical", args.canonical_name),
      )
      .first();
    if (!item) {
      return { updated: 0, not_found: 1, no_op: 0, canonical_name: args.canonical_name };
    }

    const patch: Record<string, unknown> = {};
    let changed = false;

    if (
      args.replacement_cost_gbp !== undefined &&
      args.replacement_cost_gbp !== item.replacement_cost_gbp
    ) {
      patch.replacement_cost_gbp = args.replacement_cost_gbp;
      changed = true;
    }

    if (args.included_with_rental !== undefined) {
      const existing = item.compatibility?.included_with_rental ?? [];
      const same =
        existing.length === args.included_with_rental.length &&
        existing.every((name, i) => name === args.included_with_rental![i]);
      if (!same) {
        patch.compatibility = {
          ...(item.compatibility ?? {}),
          included_with_rental: args.included_with_rental,
        };
        changed = true;
      }
    }

    if (args.kind_override !== undefined && args.kind_override !== item.kind) {
      patch.kind = args.kind_override;
      changed = true;
    }

    if (!changed) {
      return { updated: 0, not_found: 0, no_op: 1, canonical_name: args.canonical_name };
    }

    patch.updated_at = Date.now();
    await ctx.db.patch(item._id, patch);
    await ctx.db.insert("audit_log", {
      table_name: "items",
      actor: ACTOR_SEED,
      op: "update",
      count: 1,
      source_file: "convex/admin_item_attribution.ts:setItemAttribution",
      note: `name_canonical=${args.canonical_name} fields=${Object.keys(patch).join(",")}`,
      ts: Date.now(),
    });

    return { updated: 1, not_found: 0, no_op: 0, canonical_name: args.canonical_name };
  },
});

/**
 * Bulk variant. Loops over entries and applies per-item logic inline (Convex
 * mutations cannot call other mutations directly). Returns aggregate counts.
 */
export const bulkSetItemAttribution = mutation({
  args: {
    entries: v.array(
      v.object({
        canonical_name: v.string(),
        replacement_cost_gbp: v.optional(v.number()),
        included_with_rental: v.optional(v.array(v.string())),
        kind_override: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { entries }) => {
    let updated = 0;
    let not_found = 0;
    let no_op = 0;
    const missing: string[] = [];

    for (const e of entries) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) =>
          q.eq("name_canonical", e.canonical_name),
        )
        .first();
      if (!item) {
        not_found++;
        missing.push(e.canonical_name);
        continue;
      }

      const patch: Record<string, unknown> = {};
      let changed = false;

      if (
        e.replacement_cost_gbp !== undefined &&
        e.replacement_cost_gbp !== item.replacement_cost_gbp
      ) {
        patch.replacement_cost_gbp = e.replacement_cost_gbp;
        changed = true;
      }

      if (e.included_with_rental !== undefined) {
        const existing = item.compatibility?.included_with_rental ?? [];
        const same =
          existing.length === e.included_with_rental.length &&
          existing.every((name, i) => name === e.included_with_rental![i]);
        if (!same) {
          patch.compatibility = {
            ...(item.compatibility ?? {}),
            included_with_rental: e.included_with_rental,
          };
          changed = true;
        }
      }

      if (e.kind_override !== undefined && e.kind_override !== item.kind) {
        patch.kind = e.kind_override;
        changed = true;
      }

      if (!changed) {
        no_op++;
        continue;
      }

      patch.updated_at = Date.now();
      await ctx.db.patch(item._id, patch);
      updated++;
    }

    if (updated > 0) {
      await ctx.db.insert("audit_log", {
        table_name: "items",
        actor: ACTOR_SEED,
        op: "update",
        count: updated,
        source_file: "convex/admin_item_attribution.ts:bulkSetItemAttribution",
        note: `bulk patch: ${updated} updated / ${no_op} no-op / ${not_found} not-found`,
        ts: Date.now(),
      });
    }

    return { updated, no_op, not_found, missing_names: missing };
  },
});

/**
 * Hard-coded fix for the 10 seed-bug rows the audit identified.
 * Only patches when the current kind matches the EXPECTED-WRONG value, so:
 *   - safe to re-run (idempotent — no-ops once corrected)
 *   - safe if the seed script's regex is already patched (this won't override
 *     a freshly-seeded row whose kind is already correct)
 *
 * Mappings (audit_data_quality.md §5):
 *   Sony GM 24-70mm f2.8 / 16-35mm f2.8 / 70-200mm f2.8 / 90mm f2.8 / Sony 28-70mm
 *   / Canon EF 24-105mm f4 / Canon EF 16-35mm f2.8     [accessory → lens]
 *   SmallRig FX3 cage                                  [camera_body → support]
 *   Smoke Ninja Pro hazer / Smoke Ninja                [monitor → media_av]
 */
const KIND_CORRECTIONS: Array<{ name: string; from: string; to: string }> = [
  // Sony/Canon non-anamorphic lenses (regex bug: `mm f` matched "mm f" but
  // not "mm f2.8" — the original \b(lens|mm f|...) test fails on digit-after-f)
  { name: "Sony GM 24-70mm f2.8", from: "accessory", to: "lens" },
  { name: "Sony GM 16-35mm f2.8", from: "accessory", to: "lens" },
  { name: "Sony GM 70-200mm f2.8", from: "accessory", to: "lens" },
  { name: "Sony GM 90mm f2.8", from: "accessory", to: "lens" },
  { name: "Sony 28-70mm", from: "accessory", to: "lens" },
  { name: "Canon EF 24-105mm f4", from: "accessory", to: "lens" },
  { name: "Canon EF 16-35mm f2.8", from: "accessory", to: "lens" },
  // SmallRig FX3 cage (regex order bug: `fx3` matched camera_body first)
  { name: "SmallRig FX3 cage", from: "camera_body", to: "support" },
  // Smoke effects (regex order bug: `ninja` matched monitor's Atomos Ninja V)
  { name: "Smoke Ninja Pro hazer", from: "monitor", to: "media_av" },
  { name: "Smoke Ninja", from: "monitor", to: "media_av" },
];

export const correctMisclassifiedKinds = mutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    let already_correct = 0;
    let not_found = 0;
    const missing: string[] = [];
    const skipped: Array<{ name: string; current_kind: string }> = [];

    for (const fix of KIND_CORRECTIONS) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) =>
          q.eq("name_canonical", fix.name),
        )
        .first();
      if (!item) {
        not_found++;
        missing.push(fix.name);
        continue;
      }
      if (item.kind === fix.to) {
        already_correct++;
        continue;
      }
      if (item.kind !== fix.from) {
        // Item has SOME other kind — neither wrong-value nor target. Don't
        // clobber; surface for manual review.
        skipped.push({ name: fix.name, current_kind: item.kind });
        continue;
      }
      await ctx.db.patch(item._id, { kind: fix.to, updated_at: Date.now() });
      updated++;
    }

    if (updated > 0) {
      await ctx.db.insert("audit_log", {
        table_name: "items",
        actor: ACTOR_SEED,
        op: "update",
        count: updated,
        source_file: "convex/admin_item_attribution.ts:correctMisclassifiedKinds",
        note: `seed-bug kind corrections: ${updated} updated`,
        ts: Date.now(),
      });
    }

    return {
      updated,
      already_correct,
      not_found,
      missing_names: missing,
      skipped_unexpected_kind: skipped,
    };
  },
});
