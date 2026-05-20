import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * W05 Live Activity Feed — recent reservations ordered by creation time
 */
export const getRecentActivity = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  handler: async (ctx, { accountSlug, limit }) => {
    // Newest-first ordering on _creationTime is Convex's default; take(N)
    // stops after N matching rows instead of scanning the full table.
    // When account-scoped, we over-fetch 4x and post-filter (cheap).
    const overFetch = accountSlug ? limit * 4 : limit;
    let rows = await ctx.db.query("reservations").order("desc").take(overFetch);
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug).slice(0, limit);
    }

    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      renterName: (r as { renter_name?: string }).renter_name,
      itemNames: (r.items ?? []).map((i) => i.item_name),
      status: r.status,
      // Phase 2: expose order_step + is_obsolete so dashboards/diagnostics
      // can verify the poller wired the field end-to-end.
      order_step: (r as { order_step?: string }).order_step,
      is_obsolete: (r as { is_obsolete?: boolean }).is_obsolete,
      startDate: r.start_date,
      endDate: r.end_date,
      createdAt: r._creationTime,
    }));
  },
});

/**
 * W07 Return Hub — active reservations due today or overdue
 */
export const getDueReturns = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = TODAY();
    // OPEN_INDEX_NEED: composite index (status, end_date) for efficient due/overdue scan.
    let active = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();

    if (accountSlug) {
      active = active.filter((r) => r.account_slug === accountSlug);
    }

    const due = active.filter(
      (r) => r.end_date !== undefined && r.end_date <= today
    );

    const results = await Promise.all(
      due.map(async (r) => {
        let renterName = "Unknown";
        if (r.renter_id) {
          const renter = await ctx.db.get(r.renter_id);
          renterName = renter?.display_name ?? "Unknown";
        }
        return {
          reservationId: r._id,
          renterName,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          endDate: r.end_date,
          isOverdue: r.end_date !== undefined && r.end_date < today,
          accountSlug: r.account_slug,
        };
      })
    );

    return results;
  },
});

/**
 * W09 Conversation Funnel — counts by stage derived from reservations + denials
 */
export const getConversionFunnel = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      reservations = reservations.filter(
        (r) => r.account_slug === accountSlug
      );
    }
    const recent = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= cutoffStr
    );

    const bookings = recent.filter(
      (r) => r.status === "confirmed" || r.status === "completed"
    ).length;

    // Conversations as proxy for inquiries
    let conversations = await ctx.db.query("conversations").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        conversations = conversations.filter(
          (c) => c.account_id === accountRow._id
        );
      }
    }
    const inquiries = conversations.filter(
      (c) => c._creationTime >= cutoff.getTime()
    ).length;

    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        denials = denials.filter((d) => d.account_id === accountRow._id);
      }
    }
    const recentDenials = denials.filter(
      (d) => d.created_at >= cutoff.getTime()
    ).length;

    const responses = inquiries; // conversations == responses (no separate sent-count available)
    const conversionRate = inquiries > 0 ? bookings / inquiries : 0;
    const denialRate =
      inquiries > 0 ? recentDenials / inquiries : 0;

    return {
      inquiries,
      responses,
      bookings,
      conversionRate,
      denialRate,
    };
  },
});

/** W06 Return Hub — mark a reservation as returned. */
export const markReturned = mutation({
  args: {
    reservationId: v.id("reservations"),
    condition: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { reservationId, condition, notes }) => {
    const res = await ctx.db.get(reservationId);
    if (!res) throw new Error("Reservation not found");
    if (res.status === "completed") throw new Error("Already returned");
    const base = res.notes ?? "";
    const cn = notes ? "Condition: " + condition + ". " + notes : "Condition: " + condition;
    await ctx.db.patch(reservationId, {
      status: "completed",
      notes: base ? base + " | " + cn : cn,
    });
    return { ok: true };
  },
});




/**
 * T4: listObsolete — cancelled/rejected orders (lost revenue / dead deals)
 */
export const listObsolete = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    sinceTs: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, sinceTs }) => {
    const page = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .paginate(paginationOpts);
    const filtered = page.page.filter(
      (r) => !sinceTs || (r.v1_updated_at ?? r._creationTime) >= sinceTs,
    );
    const rows = await Promise.all(
      filtered.map(async (r) => {
        let renterName: string | null = null;
        if (r.renter_id) {
          const renter = await ctx.db.get(r.renter_id);
          if (renter && "display_name" in renter) {
            renterName = (renter as { display_name?: string }).display_name ?? null;
          }
        }
        return {
          order_id: r.hygglo_order_id ?? null,
          account: r.account_slug ?? null,
          order_step: r.order_step ?? null,
          obsolete_reason: r.obsolete_reason ?? "other",
          renter_name: renterName,
          start_date: r.start_date ?? null,
          end_date: r.end_date ?? null,
          items: r.items ?? [],
          last_seen_at: r.v1_updated_at ?? r._creationTime,
        };
      }),
    );
    return {
      page: rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * T4: getPipelineCounts — aggregate active order counts per order_step
 */
export const getPipelineCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r.is_obsolete) continue;
      const step = r.order_step ?? "UNKNOWN";
      counts[step] = (counts[step] ?? 0) + 1;
    }
    const paidSteps = [
      "FUNDS_RESERVED",
      "VERIFIED",
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
    ];
    const paidCount = paidSteps.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    const requestedCount = (counts["REQUEST"] ?? 0) + (counts["APPROVED"] ?? 0);
    return {
      perStep: counts,
      summary: {
        requested_unpaid: requestedCount,
        paid_active: paidCount,
        unknown: counts["UNKNOWN"] ?? 0,
      },
    };
  },
});

/**
 * Wave 2 Task 5: listForReconcile — full reservation rows for hold reconciliation.
 * Returns all fields needed by reconcile-holds.ts for a given account.
 */
export const listForReconcile = query({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    return await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("account_slug"), account_slug))
      .collect();
  },
});

// Lookup by Hygglo order ID (used by backfill scripts and reconciliation tools)
export const getByHygglo = query({
  args: { hygglo_order_id: v.string() },
  handler: async (ctx, { hygglo_order_id }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", hygglo_order_id)
      )
      .collect();
    return rows[0] ?? null;
  },
});

// Admin backfill mutation — direct status override with audit trail.
// Used for one-off corrections (e.g. v1-imported rows skipped by poller guard).
export const adminSetStatus = mutation({
  args: {
    reservation_id: v.id("reservations"),
    new_status: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, { reservation_id, new_status, reason }) => {
    const existing = await ctx.db.get(reservation_id);
    if (!existing) throw new Error(`Reservation ${reservation_id} not found`);
    const prev = existing.status;
    if (prev === new_status) return { reservation_id, prev, new_status, reason, skipped: true };
    await ctx.db.patch(reservation_id, { status: new_status });
    return { reservation_id, prev, new_status, reason, skipped: false };
  },
});

// B-3: list pending rentals for dashboard chat tool
// NOTE: Index-based filter replaced with full collect + permissive client-side filter
// because prod data has zero rows with status="pending_review". All 138 rows are
// legacy rows with order_step undefined. We must also match modern REQUEST/APPROVED
// order_step values and old "pending" status strings.
// Also match rows where booking_status === "pending_review" (captured from Hygglo since
// many "pending_review" orders have order_step=APPROVED already — renter approved by owner
// but renter hasn't paid yet).
export const listPending = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    accountSlug: v.optional(v.string()),
    // verified_only=true keeps the strict dashboard semantics (escrow paid +
    // verifying). Default false matches chat expectations: "what's pending"
    // means the whole pre-handover pipeline (REQUEST / APPROVED /
    // FUNDS_RESERVED / VERIFIED). v1 chat returned ~15 items here; v2 was
    // returning 0 because nothing happens to be in VERIFIED right now.
    verified_only: v.optional(v.boolean()),
  },
  handler: async (ctx, { paginationOpts, accountSlug, verified_only }) => {
    // See convex/order_step_semantics.ts for full semantics.
    const PIPELINE = new Set(["REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED"]);
    const page = await ctx.db
      .query("reservations")
      .order("desc")
      .paginate(paginationOpts);
    let rows = page.page.filter((r) => {
      if (r.is_obsolete === true) return false;
      if (verified_only === true) return r.order_step === "VERIFIED";
      return r.order_step !== undefined && PIPELINE.has(r.order_step);
    });
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }
    const rentals = await Promise.all(
      rows.map(async (r) => {
        let renterName = '';
        if (r.renter_id) {
          const renter = await ctx.db.get(r.renter_id);
          renterName = renter?.display_name ?? '';
        }
        return {
          id: r._id,
          accountSlug: r.account_slug,
          item: (r.items ?? []).map((i) => i.item_name).join(', '),
          renter: renterName,
          start_date: r.start_date,
          end_date: r.end_date,
          gross: r.gross_paid_gbp ?? 0,
          order_step: r.order_step ?? null,
        };
      })
    );
    return {
      count: rentals.length,
      rentals,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Fix D — Backfill: re-derive status from order_step for all existing rows.
 * Corrects ~10 rows wrongly tagged status=pending_review due to sourceFilter bug.
 */
export const adminFixStatusFromStep = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    let fixed = 0;
    // v1 parity (app.service.ts:244): APPROVED-but-unpaid is a phantom. Only
    // FUNDS_RESERVED+ rows have money locked in and count as confirmed.
    const PENDING = new Set(["REQUEST", "APPROVED"]);
    const PAID = new Set(["FUNDS_RESERVED", "VERIFIED", "BOOKED_AFTER_VERIFIED", "DELIVERED"]);
    const COMPLETED = new Set(["RETURNED", "REVIEWED"]);
    const CANCELLED_STEPS = new Set(["CANCELED", "VERIFICATION_FAILED"]);
    for (const r of rows) {
      let newStatus: string | null = null;
      if (PENDING.has(r.order_step ?? "")) newStatus = "pending_review";
      else if (PAID.has(r.order_step ?? "")) newStatus = "confirmed";
      else if (COMPLETED.has(r.order_step ?? "")) newStatus = "completed";
      else if (CANCELLED_STEPS.has(r.order_step ?? "")) newStatus = "cancelled";
      if (newStatus && r.status !== newStatus) {
        await ctx.db.patch(r._id, { status: newStatus });
        fixed++;
      }
    }
    return { total: rows.length, fixed };
  },
});

/**
 * Mark status=confirmed rows whose end_date passed more than 1 day ago as
 * completed. Hygglo drops these orders from all filters once they wrap up,
 * so the poller never sees them again — but our local copy keeps the old
 * "confirmed" status forever, inflating the Active widget's ongoing count.
 * Idempotent. Safe to run on every cron after the poll.
 */
/** Internal-cron variant of adminCompleteStaleConfirmed (same body). */
export const completeStaleConfirmedCron = internalMutation({
  args: {},
  handler: async (ctx) => {
    const dateCutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const freshThreshold = Date.now() - 2 * 60 * 60 * 1000;
    const rows = await ctx.db.query("reservations").collect();
    let completed = 0;
    for (const r of rows) {
      if (r.status !== "confirmed") continue;
      if (r.is_obsolete) continue;
      if (!r.end_date) continue;
      if ((r.end_date as string) >= dateCutoff) continue;
      // Hygglo keeps rentals in `current` until owner verifies return. Skip rows
      // where gear is still with the renter (order_step ∈ {RETURNED, DELIVERED})
      // so we don't auto-demote them to `completed` and hide them from the
      // double-booking detector.
      if (r.order_step === "RETURNED" || r.order_step === "DELIVERED") continue;
      const lastPolled =
        (r as { last_polled_at?: number }).last_polled_at ??
        (r as { _creationTime?: number })._creationTime ??
        0;
      if (lastPolled >= freshThreshold) continue;
      await ctx.db.patch(r._id, { status: "completed" });
      completed++;
    }
    return { total: rows.length, completed };
  },
});

export const adminCompleteStaleConfirmed = mutation({
  args: {},
  handler: async (ctx) => {
    const dateCutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // last_polled_at older than 2 hours → Hygglo dropped the row from every
    // filter and the poller stopped refreshing it. Two hours is roughly four
    // poll cycles, giving plenty of buffer for a single missed run.
    const freshThreshold = Date.now() - 2 * 60 * 60 * 1000;
    const rows = await ctx.db.query("reservations").collect();
    let completed = 0;
    for (const r of rows) {
      if (r.status !== "confirmed") continue;
      if (r.is_obsolete) continue;
      if (!r.end_date) continue;
      if ((r.end_date as string) >= dateCutoff) continue;
      // Hygglo keeps rentals in `current` until owner verifies return. Skip rows
      // where gear is still with the renter (order_step ∈ {RETURNED, DELIVERED})
      // so we don't auto-demote them to `completed` and hide them from the
      // double-booking detector.
      if (r.order_step === "RETURNED" || r.order_step === "DELIVERED") continue;
      const lastPolled =
        (r as { last_polled_at?: number }).last_polled_at ??
        (r as { _creationTime?: number })._creationTime ??
        0;
      if (lastPolled >= freshThreshold) continue; // poller saw it recently
      await ctx.db.patch(r._id, { status: "completed" });
      completed++;
    }
    return { total: rows.length, completed, dateCutoff, freshThreshold };
  },
});

/**
 * Patch missing rich fields (renter_name, order_step, photos_urls, etc.) on
 * an existing reservation, keyed by hygglo_order_id. Used by the
 * sync-from-exciting-lion-29 backfill script to repair rows the Trigger.dev
 * poller wrote to the wrong Convex deployment.
 *
 * Only fills BLANK fields — never overwrites already-populated values, so the
 * script is idempotent and safe to re-run.
 */
export const adminPatchRichFieldsByHyggloId = mutation({
  args: {
    hygglo_order_id: v.string(),
    renter_name: v.optional(v.string()),
    order_step: v.optional(v.string()),
    booking_status: v.optional(v.string()),
    pickup_time: v.optional(v.string()),
    return_time: v.optional(v.string()),
    pickup_date: v.optional(v.string()),
    photos_urls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", args.hygglo_order_id),
      )
      .collect();
    let patched = 0;
    for (const r of rows) {
      const patch: Record<string, unknown> = {};
      if (args.renter_name && !r.renter_name) patch.renter_name = args.renter_name;
      if (args.order_step && !r.order_step) {
        const allowed = new Set([
          "REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED",
          "BOOKED_AFTER_VERIFIED", "DELIVERED", "RETURNED", "REVIEWED",
          "CANCELED", "VERIFICATION_FAILED",
        ]);
        if (allowed.has(args.order_step)) patch.order_step = args.order_step;
      }
      if (args.booking_status && !r.booking_status) patch.booking_status = args.booking_status;
      if (args.pickup_time && !r.pickup_time) patch.pickup_time = args.pickup_time;
      if (args.return_time && !r.return_time) patch.return_time = args.return_time;
      if (args.pickup_date && !r.pickup_date) patch.pickup_date = args.pickup_date;
      if (
        args.photos_urls &&
        args.photos_urls.length > 0 &&
        (!r.photos_urls || r.photos_urls.length === 0)
      ) {
        patch.photos_urls = args.photos_urls;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(r._id, patch);
        patched++;
      }
    }
    return { rows: rows.length, patched };
  },
});

/**
 * Lightweight list of reservations missing rich fields, capped to the
 * dashboard window. Used by the backfill script to know which orders
 * to fetch from the source-of-truth deployment.
 */
export const adminListNeedsRichBackfill = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    const missing: Array<{ hygglo_order_id: string; account_slug: string }> = [];
    for (const r of rows) {
      if (!r.hygglo_order_id) continue;
      const needs =
        !r.renter_name ||
        !r.order_step ||
        !r.photos_urls ||
        r.photos_urls.length === 0;
      if (needs) {
        missing.push({
          hygglo_order_id: r.hygglo_order_id,
          account_slug: r.account_slug ?? "",
        });
      }
    }
    return missing;
  },
});

/**
 * Wave 4 — Internal query consumed by the `hygglo_poll` Mastra workflow.
 *
 * Returns pending reservations that do NOT yet have a corresponding
 * `ai_decision` row (regardless of decision status). This is the net-new
 * surface for the AI decision step.
 */
export const listPendingWithoutDecision = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const pending = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "pending_review"))
      .order("desc")
      .take(limit ?? 50);

    const out: typeof pending = [];
    for (const r of pending) {
      const decided = await ctx.db
        .query("ai_decision")
        .withIndex("by_reservation", (q) => q.eq("reservation_id", r._id))
        .first();
      if (!decided) out.push(r);
    }
    return out;
  },
});

/**
 * Phase 12.4 — patch hygglo_items[] / image_hints[] / photos_urls on an
 * existing reservation row by hygglo_order_id. Used by
 * refresh_hygglo_orders.refreshActiveStuckOrders to repopulate stuck rows
 * without going through upsertOrderAsReservation (which re-writes
 * `items: args.items` and trips the strict schema validator when the items
 * carry the PASS-10 `image` / `type` / `product_id` / `slug` shape).
 *
 * Also fires the listing_images write-through so the dashboard image bank
 * picks up product_ids on the same beat.
 */
export const patchHyggloItemsByOrderId = internalMutation({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    hygglo_items: v.array(
      v.object({
        name: v.string(),
        image_url: v.union(v.string(), v.null()),
        type: v.string(),
        qty: v.optional(v.number()),
        product_id: v.optional(v.number()),
        slug: v.optional(v.string()),
      }),
    ),
    image_hints: v.optional(
      v.array(
        v.object({
          item_name: v.string(),
          item_name_normalised: v.string(),
          image_url: v.string(),
          source: v.union(
            v.literal("hygglo_per_item"),
            v.literal("hygglo_order"),
            v.literal("manual_override"),
          ),
          captured_at: v.number(),
        }),
      ),
    ),
    photos_urls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", args.hygglo_order_id),
      )
      .collect();
    let patched = 0;
    for (const r of rows) {
      if (r.account_slug && r.account_slug !== args.account_slug) continue;
      const patch: Record<string, unknown> = {
        hygglo_items: args.hygglo_items,
        last_polled_at: Date.now(),
      };
      if (args.image_hints && args.image_hints.length > 0)
        patch.image_hints = args.image_hints;
      if (args.photos_urls && args.photos_urls.length > 0)
        patch.photos_urls = args.photos_urls;
      await ctx.db.patch(r._id, patch);
      patched++;
    }
    return { rows: rows.length, patched };
  },
});

/**
 * Phase 12.4 — list ACTIVE reservations whose hygglo_items[] are missing
 * product_id (i.e. rows polled before PASS-10 landed). Used by
 * refresh_hygglo_orders.refreshActiveStuckOrders.
 */
export const listStuckActive = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await ctx.db.query("reservations").collect();
    return rows
      .filter((r) => {
        if (r.status !== "confirmed") return false;
        if (r.is_obsolete === true) return false;
        if (!r.end_date || (r.end_date as string) < today) return false;
        if (!r.hygglo_order_id || !r.account_slug) return false;
        const hi = (r as any).hygglo_items as Array<any> | undefined;
        if (!Array.isArray(hi) || hi.length === 0) return false;
        return hi.some(
          (h) => h == null || h.product_id == null || h.image_url == null,
        );
      })
      .map((r) => ({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id as string,
        account_slug: r.account_slug as string,
      }));
  },
});
