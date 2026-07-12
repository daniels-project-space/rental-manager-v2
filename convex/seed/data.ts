// Phase 2.A v1 → v2 data import mutations.
// Source: v1 Postgres (rental_manager) → Convex (hearty-oyster-600).
// Idempotent: skip rows already imported (matched by v1_renter_profile_id / v1_rental_id).
// MASTER SAFETY RAIL: settings.ALLOW_HYGGLO_SEND must remain false (verified pre/post).
//
// All mutations write `audit_log` rows tagged with actor="phase2a-import".

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

const now = () => Date.now();

// ── BATCH IMPORT: renters ────────────────────────────────────
// Caller passes already-aggregated renter rows from v1.
export const importRentersBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      v1_renter_profile_id: v.string(),
      hygglo_user_id: v.optional(v.string()),
      display_name: v.optional(v.string()),
      email: v.optional(v.string()),
      phone: v.optional(v.string()),
      hygglo_rating: v.optional(v.number()),
      hygglo_review_count: v.optional(v.number()),
      total_rentals_count: v.number(),
      total_spend_gbp: v.number(),
      first_rental_at: v.optional(v.number()),
      last_rental_at: v.optional(v.number()),
      blacklisted: v.boolean(),
      blacklist_reason: v.optional(v.string()),
      notes: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { rows }) => {
    const t = now();
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const existing = await ctx.db
        .query("renters")
        .withIndex("by_v1_renter_profile_id", (q) => q.eq("v1_renter_profile_id", r.v1_renter_profile_id))
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert("renters", {
        ...r,
        imported_at: t,
        created_at: t,
      });
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

// ── BATCH IMPORT: reservations ───────────────────────────────
export const importReservationsBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      account_slug: v.string(),
      v1_renter_profile_id: v.optional(v.string()),    // resolved to renter_id below
      v1_rental_id: v.string(),
      hygglo_listing_id: v.optional(v.string()),
      start_date: v.string(),
      end_date: v.string(),
      duration_days: v.number(),
      status: v.string(),
      gross_paid_gbp: v.number(),
      net_to_owner_gbp: v.number(),
      platform_fee_gbp: v.number(),
      platform_fee_pct: v.number(),
      currency: v.string(),
      items: v.array(v.object({
        item_name: v.string(),
        qty: v.optional(v.number()),
        source: v.optional(v.string()),
        confidence_score: v.optional(v.number()),
        v1_extracteditem_id: v.optional(v.string()),
      })),
      v1_created_at: v.number(),
      v1_updated_at: v.number(),
      notes: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { rows }) => {
    const t = now();
    let inserted = 0;
    let skipped = 0;
    let renter_resolved = 0;

    // Cache: account_slug → account_id
    const accCache: Record<string, Id<"accounts">> = {};
    async function getAccountId(slug: string): Promise<Id<"accounts"> | undefined> {
      if (accCache[slug]) return accCache[slug];
      const a = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", slug)).first();
      if (a) accCache[slug] = a._id;
      return a?._id;
    }

    for (const r of rows) {
      const existing = await ctx.db
        .query("reservations")
        .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", r.v1_rental_id))
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }

      // Resolve renter_id (if v1 link present)
      let renter_id: Id<"renters"> | undefined;
      if (r.v1_renter_profile_id) {
        const rp = await ctx.db
          .query("renters")
          .withIndex("by_v1_renter_profile_id", (q) => q.eq("v1_renter_profile_id", r.v1_renter_profile_id!))
          .first();
        if (rp) {
          renter_id = rp._id;
          renter_resolved += 1;
        }
      }

      const account_id = await getAccountId(r.account_slug);

      await ctx.db.insert("reservations", {
        account_id,
        account_slug: r.account_slug,
        renter_id,
        v1_rental_id: r.v1_rental_id,
        hygglo_listing_id: r.hygglo_listing_id,
        listing_id: r.hygglo_listing_id,
        status: r.status,
        start_date: r.start_date,
        end_date: r.end_date,
        duration_days: r.duration_days,
        gross_paid_gbp: r.gross_paid_gbp,
        net_to_owner_gbp: r.net_to_owner_gbp,
        platform_fee_gbp: r.platform_fee_gbp,
        platform_fee_pct: r.platform_fee_pct,
        currency: r.currency,
        items: r.items,
        v1_created_at: r.v1_created_at,
        v1_updated_at: r.v1_updated_at,
        notes: r.notes,
        imported_at: t,
        created_at: t,
      });
      inserted += 1;
    }
    return { inserted, skipped, renter_resolved };
  },
});

// ── BATCH IMPORT: calendar_holds ─────────────────────────────
// Caller pre-resolves item names to item_ids (see scripts/import_v1_to_v2.ts).
export const importCalendarHoldsBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      v1_rental_id: v.string(),                  // used to look up reservation_id
      account_slug: v.string(),
      item_id: v.id("items"),
      date: v.string(),                          // ISO YYYY-MM-DD
      status: v.string(),
    })),
  },
  handler: async (ctx, { rows }) => {
    const t = now();
    let inserted = 0;
    let skipped = 0;

    // Resolve reservation_id once per rental_id
    const resCache: Record<string, Id<"reservations"> | undefined> = {};
    async function getReservationId(v1_rental_id: string) {
      if (v1_rental_id in resCache) return resCache[v1_rental_id];
      const r = await ctx.db
        .query("reservations")
        .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", v1_rental_id))
        .first();
      resCache[v1_rental_id] = r?._id;
      return r?._id;
    }

    for (const row of rows) {
      const reservation_id = await getReservationId(row.v1_rental_id);
      if (!reservation_id) {
        skipped += 1;
        continue;
      }
      // Idempotency: skip if (item_id, date, reservation_id) already exists
      const existing = await ctx.db
        .query("calendar_holds")
        .withIndex("by_item_date", (q) => q.eq("item_id", row.item_id).eq("date", row.date))
        .filter((q) => q.eq(q.field("reservation_id"), reservation_id))
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }
      await ctx.db.insert("calendar_holds", {
        item_id: row.item_id,
        reservation_id,
        account_slug: row.account_slug,
        date: row.date,
        status: row.status,
        imported_at: t,
        created_at: t,
      });
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

// ── HELPER: lookup item_id by name (canonical or input) ──────
export const lookupItemIdsByNames = internalQuery({
  args: { names: v.array(v.string()) },
  handler: async (ctx, { names }) => {
    const out: Record<string, Id<"items"> | null> = {};
    for (const name of names) {
      let it = await ctx.db.query("items").withIndex("by_canonical_name", (q) => q.eq("name_canonical", name)).first();
      if (!it) {
        // Linear fallback by name_input (rare)
        const all = await ctx.db.query("items").collect();
        it = all.find((x) => x.name_input === name) ?? null;
      }
      out[name] = it?._id ?? null;
    }
    return out;
  },
});

// ── AUDIT: write import_audit row ───────────────────────────
export const writeImportAudit = internalMutation({
  args: {
    table_name: v.string(),
    v1_table_source: v.string(),
    v1_row_count: v.number(),
    v2_row_count: v.number(),
    sum_field: v.optional(v.string()),
    v1_sum: v.optional(v.number()),
    v2_sum: v.optional(v.number()),
    sample_count: v.number(),
    sample_pass_count: v.number(),
    sample_fail_count: v.number(),
    sample_failures: v.array(v.any()),
    import_started_at: v.number(),
    status: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const drift = a.v1_row_count - a.v2_row_count;
    const sum_drift =
      a.v1_sum !== undefined && a.v2_sum !== undefined
        ? Math.round((a.v1_sum - a.v2_sum) * 100) / 100
        : undefined;
    await ctx.db.insert("import_audit", {
      ...a,
      drift,
      sum_drift,
      import_completed_at: now(),
    });
    await ctx.db.insert("audit_log", {
      table_name: a.table_name,
      actor: "phase2a-import",
      op: "insert",
      count: a.v2_row_count,
      source_file: "convex/seed/data.ts",
      note: `import_audit:${a.status} drift=${drift}`,
      ts: now(),
    });
    return { ok: true, drift, sum_drift };
  },
});

// ── VERIFICATION QUERIES ─────────────────────────────────────
export const verifyCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const renters = await ctx.db.query("renters").collect();
    const reservations = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-shot seed/dev tooling
    const holds = await ctx.db.query("calendar_holds").collect();
    const audits = await ctx.db.query("import_audit").collect();
    const settings = await ctx.db.query("settings").first();
    return {
      renters: renters.length,
      reservations: reservations.length,
      calendar_holds: holds.length,
      import_audit: audits.length,
      settings_invariant: {
        ALLOW_HYGGLO_SEND: settings?.ALLOW_HYGGLO_SEND ?? null,
        read_only_mode: settings?.read_only_mode ?? null,
      },
    };
  },
});

export const fetchReservationsByV1Ids = internalQuery({
  args: { v1_rental_ids: v.array(v.string()) },
  handler: async (ctx, { v1_rental_ids }) => {
    const out = [];
    for (const rid of v1_rental_ids) {
      const r = await ctx.db
        .query("reservations")
        .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", rid))
        .first();
      if (!r) {
        out.push({ v1_rental_id: rid, found: false });
        continue;
      }
      // Count calendar holds for this reservation
      const holds = await ctx.db
        .query("calendar_holds")
        .withIndex("by_reservation", (q) => q.eq("reservation_id", r._id))
        .collect();
      out.push({
        v1_rental_id: rid,
        found: true,
        _id: r._id,
        account_slug: r.account_slug,
        renter_id: r.renter_id,
        start_date: r.start_date,
        end_date: r.end_date,
        duration_days: r.duration_days,
        status: r.status,
        gross_paid_gbp: r.gross_paid_gbp,
        net_to_owner_gbp: r.net_to_owner_gbp,
        items_count: r.items?.length ?? 0,
        calendar_holds_count: holds.length,
      });
    }
    return out;
  },
});

export const fetchRenterByV1Id = internalQuery({
  args: { v1_renter_profile_id: v.string() },
  handler: async (ctx, { v1_renter_profile_id }) => {
    const r = await ctx.db
      .query("renters")
      .withIndex("by_v1_renter_profile_id", (q) => q.eq("v1_renter_profile_id", v1_renter_profile_id))
      .first();
    return r ? { _id: r._id, display_name: r.display_name, total_spend_gbp: r.total_spend_gbp } : null;
  },
});

// ── BACKFILL: reservation items ──────────────────────────────
// Updates existing reservation rows (by v1_rental_id) to set items[].
// Called by scripts/backfill-reservation-items.mjs.
export const backfillReservationItemsBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      v1_rental_id: v.string(),
      items: v.array(v.object({
        item_name: v.string(),
        qty: v.optional(v.number()),
        source: v.optional(v.string()),
        confidence_score: v.optional(v.number()),
        v1_extracteditem_id: v.optional(v.string()),
      })),
    })),
  },
  handler: async (ctx, { rows }) => {
    let updated = 0;
    let skipped_not_found = 0;
    let skipped_already_has_items = 0;
    for (const row of rows) {
      const res = await ctx.db
        .query('reservations')
        .withIndex('by_v1_rental_id', (q) => q.eq('v1_rental_id', row.v1_rental_id))
        .first();
      if (!res) { skipped_not_found += 1; continue; }
      // Only backfill if items is currently empty
      if ((res.items ?? []).length > 0) { skipped_already_has_items += 1; continue; }
      await ctx.db.patch(res._id, { items: row.items });
      updated += 1;
    }
    return { updated, skipped_not_found, skipped_already_has_items };
  },
});

// ── BACKFILL: item acquisition costs ────────────────────────
// Updates items rows setting acquisition_cost_gbp from v1's ACQUISITION_COSTS data.
// Called by scripts/backfill-acquisition-costs.mjs.
export const backfillItemAcquisitionCostsBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      name_canonical: v.string(),
      acquisition_cost_gbp: v.number(),
    })),
  },
  handler: async (ctx, { rows }) => {
    let updated = 0;
    let not_found = 0;
    for (const row of rows) {
      const items = await ctx.db
        .query('items')
        .withIndex('by_canonical_name', (q) => q.eq('name_canonical', row.name_canonical))
        .collect();
      if (items.length === 0) { not_found += 1; continue; }
      for (const item of items) {
        await ctx.db.patch(item._id, { acquisition_cost_gbp: row.acquisition_cost_gbp });
        updated += 1;
      }
    }
    return { updated, not_found };
  },
});


// -- BACKFILL: reservation pickup_date (BF-06) ---------------------
// Patches reservations.pickup_date from v1 booking.pickup_date.
// pickup_date is the actual gear handoff date (vs. Hygglo start_date which is
// the renter-requested date -- can differ by +/-1 day in ~13% of cases).
// Called by scripts/backfill-pickup-dates.mjs.
export const backfillPickupDatesBatch = internalMutation({
  args: {
    rows: v.array(v.object({
      v1_rental_id: v.string(),
      pickup_date: v.string(), // ISO YYYY-MM-DD
    })),
  },
  handler: async (ctx, { rows }) => {
    let updated = 0;
    let skipped_not_found = 0;
    let skipped_already_set = 0;
    for (const row of rows) {
      const res = await ctx.db
        .query('reservations')
        .withIndex('by_v1_rental_id', (q) => q.eq('v1_rental_id', row.v1_rental_id))
        .first();
      if (!res) { skipped_not_found += 1; continue; }
      if (res.pickup_date) { skipped_already_set += 1; continue; }
      await ctx.db.patch(res._id, { pickup_date: row.pickup_date });
      updated += 1;
    }
    return { updated, skipped_not_found, skipped_already_set };
  },
});
