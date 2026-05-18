/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Admin Reclassify — Phase 3a backfill mutation
 *
 *  Walks obsolete reservations, looks up the latest hygglo_messages thread,
 *  runs the chat regex patterns + structural decision matrix, and patches
 *  the 10 new optional fields on each row.
 *
 *  Idempotent: with `only_unreclassified: true` (default), rows that already
 *  have `reclassified_at` set are skipped. Re-running is safe.
 *
 *  Operator-paged: limit defaults to 50/batch (well under Convex 8s mutation
 *  budget). Re-invoke until `processed === 0`.
 *
 *  Sample run:
 *    npx convex run --prod admin_reclassify:reclassifyBatch '{"limit": 50}'
 *    npx convex run --prod admin_reclassify:listReclassifiedSample '{"limit": 20}'
 * ──────────────────────────────────────────────────────────────────────────
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  classifyDenialActor,
  OWNER_CANCEL_RE,
  RENTER_CANCEL_RE,
  OWNER_APPROVAL_RE,
  type ClassifierInput,
  type LastMessageSender,
} from "./lib/denial_classifier";

type Reservation = Doc<"reservations">;
type Message = Doc<"hygglo_messages">;

const RECENT_MESSAGE_WINDOW = 5; // how many trailing messages to scan for chat regex hits

/** Derive last_message_sender (4-outcome canonical 3-value union) from a raw
 *  hygglo_messages.sender string. Hygglo emits "owner" / "renter" / other. */
function mapSender(raw: string | undefined | null): LastMessageSender {
  if (!raw) return "none";
  const s = raw.toLowerCase();
  if (s === "owner" || s === "me") return "me";
  if (s === "renter") return "renter";
  return "none";
}

/** Pick the best-effort "obsolete_at" timestamp from a reservation.
 *  Priority: explicit obsolete_at → demand_loss_classified_at →
 *  v1_updated_at → _creationTime. */
function deriveObsoleteAt(r: Reservation): number {
  return (
    r.obsolete_at ??
    r.demand_loss_classified_at ??
    r.v1_updated_at ??
    r._creationTime
  );
}

/** Internal: scan trailing N messages for regex hits, enforcing sender
 *  direction (owner-cancel must come from owner; renter-cancel from renter). */
function scanRegexHits(messages: Message[]): {
  owner_cancel: boolean;
  renter_cancel: boolean;
  owner_approval: boolean;
} {
  // Use the trailing N (most recent) — hygglo_messages indexed by_thread is
  // insertion order; we sort by hygglo_sent_at if present.
  const sorted = [...messages].sort(
    (a, b) => (a.hygglo_sent_at ?? a.fetched_at) - (b.hygglo_sent_at ?? b.fetched_at),
  );
  const recent = sorted.slice(-RECENT_MESSAGE_WINDOW);
  let owner_cancel = false;
  let renter_cancel = false;
  let owner_approval = false;
  for (const m of recent) {
    const body = m.body_text ?? "";
    const sender = (m.sender ?? "").toLowerCase();
    if (sender === "owner" && OWNER_CANCEL_RE.test(body)) owner_cancel = true;
    if (sender === "renter" && RENTER_CANCEL_RE.test(body)) renter_cancel = true;
    if (sender === "owner" && OWNER_APPROVAL_RE.test(body)) owner_approval = true;
  }
  return { owner_cancel, renter_cancel, owner_approval };
}

// ──────────────────────────────────────────────────────────────────────────
// Main batch mutation
// ──────────────────────────────────────────────────────────────────────────
export const reclassifyBatch = mutation({
  args: {
    limit: v.optional(v.number()),
    only_unreclassified: v.optional(v.boolean()),
    /** Phase 3d — for hard-flip backfills: only pick rows whose
     *  `reclassified_at` is < this timestamp. Lets the caller loop
     *  through every row exactly once even when `only_unreclassified=false`,
     *  because each batch's writes advance their `reclassified_at` past
     *  this watermark. Defaults to `undefined` (no watermark filter). */
    reclassified_before: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { limit = 50, only_unreclassified = true, reclassified_before },
  ): Promise<{
    processed: number;
    skipped_already_classified: number;
    by_outcome: Record<string, number>;
    by_confidence: Record<string, number>;
    by_signal: Record<string, number>;
    pending_remaining_est: number;
  }> => {
    // Fetch a window of obsolete-or-cancelled reservations. We don't have a
    // single composite index for (is_obsolete OR status IN cancelled/declined),
    // so fan out: walk by _creationTime desc and filter in-app.
    const candidates: Reservation[] = [];
    let scanned = 0;
    const SCAN_CAP = Math.max(limit * 8, 400); // need headroom because most aren't obsolete

    for await (const r of ctx.db.query("reservations").order("desc")) {
      scanned++;
      const isObsolete = r.is_obsolete === true;
      const isCancelled = r.status === "cancelled" || r.status === "declined";
      if (!isObsolete && !isCancelled) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      if (only_unreclassified && r.reclassified_at != null) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      // Phase 3d hard-flip helper: when caller passes a watermark, skip rows
      // already reclassified at-or-after it (i.e. already processed this run).
      if (
        reclassified_before !== undefined &&
        r.reclassified_at != null &&
        r.reclassified_at >= reclassified_before
      ) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      candidates.push(r);
      if (candidates.length >= limit) break;
      if (scanned >= SCAN_CAP) break;
    }

    let processed = 0;
    let skipped = 0;
    const byOutcome: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    const bySignal: Record<string, number> = {};

    for (const r of candidates) {
      if (only_unreclassified && r.reclassified_at != null) {
        skipped++;
        continue;
      }

      // Fetch chat thread messages for this rental (joined by thread_id ==
      // hygglo_order_id). Use by_thread index for cheap O(log n + k) lookup.
      const threadId = r.hygglo_order_id ?? null;
      let messages: Message[] = [];
      if (threadId) {
        messages = await ctx.db
          .query("hygglo_messages")
          .withIndex("by_thread", (q) => q.eq("thread_id", threadId))
          .collect();
      }

      const sortedMsgs = [...messages].sort(
        (a, b) => (a.hygglo_sent_at ?? a.fetched_at) - (b.hygglo_sent_at ?? b.fetched_at),
      );
      const lastMsg = sortedMsgs[sortedMsgs.length - 1];
      const lastMessageSender = mapSender(lastMsg?.sender);
      const lastMessageAt = lastMsg
        ? (lastMsg.hygglo_sent_at ?? lastMsg.fetched_at ?? null)
        : null;

      const hits = scanRegexHits(messages);
      const obsoleteAt = deriveObsoleteAt(r);

      const input: ClassifierInput = {
        obsolete_reason: r.obsolete_reason ?? null,
        order_step: r.order_step ?? null,
        gross_paid_gbp: r.gross_paid_gbp ?? 0,
        last_message_sender: lastMessageSender,
        last_message_at: lastMessageAt,
        obsolete_at: obsoleteAt,
        chat_owner_cancel_hit: hits.owner_cancel,
        chat_renter_cancel_hit: hits.renter_cancel,
        chat_owner_approval_hit: hits.owner_approval,
        // Phase 3d — Hygglo system event signal (ground truth, beats chat regex).
        hygglo_system_signal: r.hygglo_system_signal ?? null,
      };

      const result = classifyDenialActor(input);

      // Idempotent write — never overwrite an existing denial_actor with a
      // different value (denial_actor is the canonical, set once; the
      // reclassified_* fields are the auditable parallel).
      const patch: Partial<Reservation> = {
        reclassified_outcome: result.outcome,
        reclassified_at: Date.now(),
        reclassified_signal: result.signal,
        reclassified_confidence: result.confidence,
        last_message_sender_at_obsolete: lastMessageSender,
        last_message_at_obsolete: lastMessageAt ?? undefined,
        chat_owner_cancel_hit: hits.owner_cancel,
        chat_renter_cancel_hit: hits.renter_cancel,
        chat_owner_approval_hit: hits.owner_approval,
        obsolete_at: obsoleteAt,
      };
      // Only set denial_actor the first time.
      if (r.denial_actor == null) {
        patch.denial_actor = result.outcome;
      }

      await ctx.db.patch(r._id, patch);

      processed++;
      byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
      byConfidence[result.confidence] = (byConfidence[result.confidence] ?? 0) + 1;
      bySignal[result.signal] = (bySignal[result.signal] ?? 0) + 1;
    }

    // Best-effort estimate of remaining pending rows (capped scan, so this is
    // an upper-bound heuristic, not an exact count).
    let pendingEst = 0;
    let pendingScanned = 0;
    const PENDING_SCAN_CAP = 600;
    for await (const r of ctx.db.query("reservations").order("desc")) {
      pendingScanned++;
      const isObsolete = r.is_obsolete === true;
      const isCancelled = r.status === "cancelled" || r.status === "declined";
      if ((isObsolete || isCancelled) && r.reclassified_at == null) {
        pendingEst++;
      }
      if (pendingScanned >= PENDING_SCAN_CAP) break;
    }

    return {
      processed,
      skipped_already_classified: skipped,
      by_outcome: byOutcome,
      by_confidence: byConfidence,
      by_signal: bySignal,
      pending_remaining_est: pendingEst,
    };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Inspection query — sample N most-recently-reclassified rows for Daniel
// ──────────────────────────────────────────────────────────────────────────
export const listReclassifiedSample = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 20 }) => {
    const rows: Reservation[] = [];
    for await (const r of ctx.db.query("reservations").order("desc")) {
      if (r.reclassified_at != null) rows.push(r);
      if (rows.length >= limit * 3) break; // small headroom for shuffle
    }
    // Stable "spread" sample: take every Nth row up to `limit` for variety.
    const stride = Math.max(1, Math.floor(rows.length / Math.max(1, limit)));
    const sampled: Reservation[] = [];
    for (let i = 0; i < rows.length && sampled.length < limit; i += stride) {
      sampled.push(rows[i]);
    }

    return sampled.map((r) => ({
      _id: r._id,
      hygglo_order_id: r.hygglo_order_id ?? null,
      status: r.status,
      is_obsolete: r.is_obsolete ?? false,
      obsolete_reason: r.obsolete_reason ?? null,
      order_step: r.order_step ?? null,
      gross_paid_gbp: r.gross_paid_gbp ?? 0,
      last_message_sender_at_obsolete: r.last_message_sender_at_obsolete ?? null,
      last_message_at_obsolete: r.last_message_at_obsolete ?? null,
      chat_owner_cancel_hit: r.chat_owner_cancel_hit ?? false,
      chat_renter_cancel_hit: r.chat_renter_cancel_hit ?? false,
      chat_owner_approval_hit: r.chat_owner_approval_hit ?? false,
      denial_actor: r.denial_actor ?? null,
      reclassified_outcome: r.reclassified_outcome ?? null,
      reclassified_confidence: r.reclassified_confidence ?? null,
      reclassified_signal: r.reclassified_signal ?? null,
      reclassified_at: r.reclassified_at ?? null,
    }));
  },
});
