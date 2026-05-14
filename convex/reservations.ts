import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
    // OPEN_INDEX_NEED: index by _creationTime DESC would avoid full scan here.
    let rows = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }
    rows.sort((a, b) => b._creationTime - a._creationTime);
    rows = rows.slice(0, limit);

    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      itemNames: (r.items ?? []).map((i) => i.item_name),
      status: r.status,
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
export const listObsolete = query({
  args: { sinceTs: v.optional(v.number()) },
  handler: async (ctx, { sinceTs }) => {
    const rows = await ctx.db.query("reservations").collect();
    const filtered = rows
      .filter((r) => r.is_obsolete === true)
      .filter(
        (r) =>
          !sinceTs ||
          (r.v1_updated_at ?? r._creationTime) >= sinceTs
      );
    return Promise.all(
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
      })
    );
  },
});

/**
 * T4: getPipelineCounts — aggregate active order counts per order_step
 */
export const getPipelineCounts = query({
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
export const listPending = query({
  args: { accountSlug: v.optional(v.string()) },
  handler: async (ctx, { accountSlug }) => {
    const allRows = await ctx.db.query("reservations").collect();
    // Fix C: hard exclusion — if step is a paid step, never show as pending
    const PAID_STEPS = new Set([
      "FUNDS_RESERVED", "VERIFIED", "BOOKED_AFTER_VERIFIED",
      "DELIVERED", "RETURNED", "REVIEWED",
    ]);
    let rows = allRows.filter((r) => {
      if (r.is_obsolete === true) return false;
      // Hard exclusion: if step is paid, never pending
      if (r.order_step && PAID_STEPS.has(r.order_step)) return false;
      // Canonical: booking_status field directly from Hygglo (most accurate when present)
      if ((r as any).booking_status === "pending_review") return true;
      // Modern: status field set to pending_review by poller (sourceFilter="pending")
      if (r.status === "pending_review" || r.status === "pending") return true;
      // Fallback: explicit pending order_step (REQUEST = awaiting owner accept)
      if (r.order_step === "REQUEST" || r.order_step === "APPROVED") return true;
      return false;
    });
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }
    rows.sort((a, b) => b._creationTime - a._creationTime);
    const top = rows.slice(0, 20);
    const rentals = await Promise.all(
      top.map(async (r) => {
        let renterName = "";
        if (r.renter_id) {
          const renter = await ctx.db.get(r.renter_id);
          renterName = renter?.display_name ?? "";
        }
        return {
          id: r._id,
          accountSlug: r.account_slug,
          item: (r.items ?? []).map((i) => i.item_name).join(", "),
          renter: renterName,
          start_date: r.start_date,
          end_date: r.end_date,
          gross: r.gross_paid_gbp ?? 0,
        };
      })
    );
    return { count: rows.length, rentals };
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
    // v1 parity: APPROVED (owner accepted) is treated as confirmed, not pending.
    // Only REQUEST (renter waiting on owner) is genuinely pending.
    const PENDING = new Set(["REQUEST"]);
    const PAID = new Set(["APPROVED", "FUNDS_RESERVED", "VERIFIED", "BOOKED_AFTER_VERIFIED", "DELIVERED"]);
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
