import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── order_step helpers ────────────────────────────────────────

/** All recognised Hygglo order step keys. */
const VALID_ORDER_STEPS = new Set([
  "REQUEST",
  "APPROVED",
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
  "CANCELED",
  "VERIFICATION_FAILED",
]);

/** Steps where the renter has already paid. */
export const PAID_ORDER_STEPS = [
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
] as const;

/**
 * Extract the active order step from a raw Hygglo order object.
 * Looks at:
 *   - `order.steps[]`          — direct detail response from /v4/my/orders/:id
 *   - `order.detail.steps[]`   — v1 wrapper shape (detail nested under .detail)
 *   - `order._detail.steps[]`  — v1 wrapper shape (detail nested under ._detail)
 * Returns null when the step array is absent or no step is active.
 * Logs a warning and returns undefined for unrecognised step keys.
 */
function extractActiveOrderStep(order: any): string | null | undefined {
  const steps = order?.steps ?? order?.detail?.steps ?? order?._detail?.steps;
  if (!Array.isArray(steps)) return null;
  const active = steps.find((s: any) => s?.active === true);
  if (!active) return null;
  const key: string = active?.key;
  if (!VALID_ORDER_STEPS.has(key)) {
    console.warn(`[hygglo] Unrecognised order_step key: "${key}" — storing undefined`);
    return undefined;
  }
  return key;
}

/** Priority map for order steps (higher = more advanced). */
const STEP_PRIORITY: Record<string, number> = {
  REVIEWED: 8,
  RETURNED: 7,
  DELIVERED: 6,
  BOOKED_AFTER_VERIFIED: 5,
  VERIFIED: 4,
  FUNDS_RESERVED: 3,
  APPROVED: 2,
  REQUEST: 1,
  CANCELED: 0,
  VERIFICATION_FAILED: 0,
};

/**
 * Returns true when `incomingStep` is a regression vs. `storedStep`
 * and is NOT a terminal cancellation — meaning we should skip the update.
 */
function isStepRegression(stored: string | null | undefined, incoming: string | null | undefined): boolean {
  if (!stored || !incoming) return false;
  // CANCELED is always allowed through (terminal)
  if (incoming === "CANCELED") return false;
  const storedPriority = STEP_PRIORITY[stored] ?? -1;
  const incomingPriority = STEP_PRIORITY[incoming] ?? -1;
  return incomingPriority < storedPriority;
}

const messageArgs = v.array(
  v.object({
    thread_id: v.string(),
    message_id: v.string(),
    sender: v.string(),
    sender_name: v.optional(v.string()),
    body_text: v.string(),
    hygglo_sent_at: v.optional(v.number()),
    fetched_at: v.number(),
    raw: v.optional(v.string()),
  })
);

// ── Mutations ─────────────────────────────────────────────────

/**
 * Public mutation called by Trigger.dev via ConvexHttpClient.
 * Deduplicates by (thread_id, message_id) — safe to call repeatedly.
 */
export const upsertMessages = mutation({
  args: {
    account_slug: v.string(),
    messages: messageArgs,
  },
  handler: async (ctx, { account_slug, messages }): Promise<{ inserted: number; skipped: number }> => {
    let inserted = 0;
    let skipped = 0;
    for (const msg of messages) {
      const existing = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread_and_message", (q) =>
          q.eq("thread_id", msg.thread_id).eq("message_id", msg.message_id)
        )
        .first();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("hygglo_messages", {
        account_slug,
        thread_id: msg.thread_id,
        message_id: msg.message_id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        body_text: msg.body_text,
        hygglo_sent_at: msg.hygglo_sent_at,
        fetched_at: msg.fetched_at,
        raw: msg.raw,
      });
      inserted++;
    }
    return { inserted, skipped };
  },
});

// ── Queries ───────────────────────────────────────────────────

/**
 * Return the most recent N messages, optionally filtered by account.
 * Ordered by hygglo_sent_at desc (most recent first).
 */
export const getRecentMessages = query({
  args: {
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, limit = 15 }) => {
    let rows;
    if (accountSlug) {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
        .order("desc")
        .take(limit);
    } else {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_fetched")
        .order("desc")
        .take(limit);
    }
    return rows.sort(
      (a, b) =>
        (b.hygglo_sent_at ?? b.fetched_at) - (a.hygglo_sent_at ?? a.fetched_at)
    );
  },
});

// ── Reservation upsert ────────────────────────────────────────

const orderItemArgs = v.object({
  item_name: v.string(),
  qty: v.optional(v.number()),
});

/**
 * Public mutation called by poll-hygglo-inbox after each order fetch.
 * Upserts a reservation row keyed by hygglo_order_id.
 * Does NOT overwrite rows that have v1_rental_id set (historical imports stay authoritative).
 */
export const upsertOrderAsReservation = mutation({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    status: v.string(),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
    gross_paid_gbp: v.optional(v.number()),
    net_to_owner_gbp: v.optional(v.number()),
    currency: v.optional(v.string()),
    items: v.array(orderItemArgs),
    duration_days: v.optional(v.number()),
    /** Raw Hygglo order object — used to extract order_step. */
    order: v.optional(v.any()),
    /** Filter label from the poll cycle (e.g. "obsolete", "active"). */
    sourceFilter: v.optional(v.string()),
    renter_name: v.optional(v.string()),
    /** Raw Hygglo booking status (e.g. "pending_review", "confirmed"). */
    booking_status: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ action: "inserted" | "updated" | "skipped" }> => {
    const existing = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", args.hygglo_order_id))
      .first();

    const now = Date.now();

    // ── order_step extraction ──────────────────────────────────
    // null = no active step found (treat as undefined for schema compat); undefined = unrecognised key
    const incomingStepRaw = extractActiveOrderStep(args.order);
    const incomingStep = incomingStepRaw === null ? undefined : (incomingStepRaw as
      | "REQUEST" | "APPROVED" | "FUNDS_RESERVED" | "VERIFIED" | "BOOKED_AFTER_VERIFIED"
      | "DELIVERED" | "RETURNED" | "REVIEWED" | "CANCELED" | "VERIFICATION_FAILED"
      | undefined);

    // ── obsolete classification ────────────────────────────────
    let obsoleteFields: {
      is_obsolete?: boolean;
      obsolete_reason?: "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
    } = {};
    if (args.sourceFilter === "obsolete") {
      let reason: "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
      if (incomingStep === "REQUEST") {
        reason = "owner_denied";
      } else if (incomingStep === "CANCELED") {
        reason = "renter_cancelled";
      } else if (
        incomingStep === "VERIFIED" ||
        incomingStep === "FUNDS_RESERVED"
      ) {
        reason = "verification_failed";
      } else {
        reason = "other";
      }
      obsoleteFields = { is_obsolete: true, obsolete_reason: reason };
    }

    const baseFields = {
      account_slug: args.account_slug,
      hygglo_order_id: args.hygglo_order_id,
      status: args.status,
      start_date: args.start_date,
      end_date: args.end_date,
      gross_paid_gbp: args.gross_paid_gbp,
      net_to_owner_gbp: args.net_to_owner_gbp,
      currency: args.currency,
      items: args.items,
      duration_days: args.duration_days,
      renter_name: args.renter_name,
      booking_status: args.booking_status,
    };

    if (existing) {
      // Skip rows with v1_rental_id — historical import is authoritative.
      if (existing.v1_rental_id) return { action: "skipped" };

      // ── step-priority dedup ──────────────────────────────────
      const storedStep = (existing as any).order_step ?? null;
      const isObsoleteUpsert = args.sourceFilter === "obsolete";

      if (
        !isObsoleteUpsert &&
        incomingStep !== undefined &&
        isStepRegression(storedStep, incomingStep)
      ) {
        // Stale filter response — don't roll back an advanced step.
        console.info(
          `[hygglo] Step regression skipped for order ${args.hygglo_order_id}: ` +
            `stored="${storedStep}" incoming="${incomingStep}"`
        );
        // Still apply non-step fields (dates, amounts) but preserve order_step.
        await ctx.db.patch(existing._id, { ...baseFields, ...obsoleteFields });
        return { action: "updated" };
      }

      const stepPatch =
        incomingStep !== undefined ? { order_step: incomingStep } : {};
      await ctx.db.patch(existing._id, {
        ...baseFields,
        ...stepPatch,
        ...obsoleteFields,
      });
      return { action: "updated" };
    }

    // ── INSERT ────────────────────────────────────────────────
    const stepInsert =
      incomingStep !== undefined ? { order_step: incomingStep } : {};
    await ctx.db.insert("reservations", {
      ...baseFields,
      ...stepInsert,
      ...obsoleteFields,
      created_at: now,
    });
    return { action: "inserted" };
  },
});

// ── Renter upsert (batch) ─────────────────────────────────────

/**
 * Upserts renters extracted from Hygglo order details.
 * Dedup by hygglo_user_id (indexed) when present, else by display_name (indexed).
 * Called by poll-hygglo-inbox and backfill scripts.
 */
export const upsertRentersBatch = mutation({
  args: {
    account_slug: v.string(),
    renters: v.array(
      v.object({
        hygglo_user_id: v.optional(v.string()),
        display_name: v.string(),
      })
    ),
  },
  handler: async (ctx, { account_slug: _account_slug, renters }): Promise<{ upserted: number; skipped: number }> => {
    let upserted = 0;
    let skipped = 0;
    const now = Date.now();

    for (const r of renters) {
      // 1. Try by hygglo_user_id (indexed, fast)
      if (r.hygglo_user_id) {
        const existing = await ctx.db
          .query("renters")
          .withIndex("by_hygglo_user_id", (q) => q.eq("hygglo_user_id", r.hygglo_user_id))
          .first();
        if (existing) {
          skipped++;
          continue;
        }
      }

      // 2. Fallback: by display_name (indexed)
      const displayNameTrimmed = r.display_name.trim();
      const existingByName = await ctx.db
        .query("renters")
        .withIndex("by_display_name", (q) => q.eq("display_name", displayNameTrimmed))
        .first();
      if (existingByName) {
        skipped++;
        continue;
      }

      await ctx.db.insert("renters", {
        hygglo_user_id: r.hygglo_user_id,
        display_name: displayNameTrimmed,
        created_at: now,
      });
      upserted++;
    }

    return { upserted, skipped };
  },
});

// ── Conversation upsert (batch) ───────────────────────────────

/**
 * Upserts one conversation row per Hygglo order that has chat messages.
 * Dedup by thread_id (= String(order.id)). Resolves renter_id by hygglo_user_id or name.
 * Called by poll-hygglo-inbox and backfill scripts.
 */
export const upsertConversationsBatch = mutation({
  args: {
    account_slug: v.string(),
    conversations: v.array(
      v.object({
        thread_id: v.string(),
        hygglo_user_id: v.optional(v.string()),
        display_name: v.string(),
        last_msg_at: v.number(),
        created_at: v.number(),
      })
    ),
  },
  handler: async (ctx, { account_slug, conversations }): Promise<{ upserted: number; skipped: number }> => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", account_slug))
      .first();
    const account_id = account?._id;

    let upserted = 0;
    let skipped = 0;

    for (const c of conversations) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .first();

      if (existing) {
        if (c.last_msg_at > existing.last_msg_at) {
          await ctx.db.patch(existing._id, { last_msg_at: c.last_msg_at });
        }
        skipped++;
        continue;
      }

      // Resolve renter_id: prefer hygglo_user_id match, fall back to display_name (both indexed)
      let renter_id: import("./_generated/dataModel").Id<"renters"> | undefined;
      if (c.hygglo_user_id) {
        const renter = await ctx.db
          .query("renters")
          .withIndex("by_hygglo_user_id", (q) => q.eq("hygglo_user_id", c.hygglo_user_id))
          .first();
        renter_id = renter?._id;
      }
      if (!renter_id) {
        const renter = await ctx.db
          .query("renters")
          .withIndex("by_display_name", (q) => q.eq("display_name", c.display_name.trim()))
          .first();
        renter_id = renter?._id;
      }

      await ctx.db.insert("conversations", {
        thread_id: c.thread_id,
        account_id,
        renter_id,
        last_msg_at: c.last_msg_at,
        created_at: c.created_at,
      });
      upserted++;
    }

    return { upserted, skipped };
  },
});



// B-3: list messages by thread_id for dashboard chat tool
export const listByThread = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const rows = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("asc")
      .take(50);
    return rows.map((m) => ({
      role: m.sender === "owner" ? "owner" : "renter",
      sender_name: m.sender_name ?? m.sender,
      content: m.body_text,
      timestamp: m.hygglo_sent_at ?? m.fetched_at,
    }));
  },
});
