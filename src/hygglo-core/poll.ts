/**
 * hygglo-core/poll — the PURE polling assembler.
 *
 * `corePoll(account)` reproduces, on top of hygglo-core, the exact data the
 * live `src/trigger/poll-hygglo.ts:scrapeAccount` + the batch-build loop in its
 * `run()` produce — WITHOUT any of the I/O side-effects. It performs the same
 * READ-ONLY Hygglo GETs the poller does every 15 min (listOrders per filter →
 * getOrder detail), runs the parity-critical `shape.ts` mappers, and assembles
 * the SAME four payload arrays the poller hands to the Convex `upsert*Batch`
 * mutations:
 *
 *   reservations  → `upsertOrdersAsReservationsBatch({ orders: [...] })`
 *   renters       → `upsertRentersBatch({ account_slug, renters: [...] })`
 *   conversations → `upsertConversationsBatch({ account_slug, conversations })`
 *   messages      → `upsertMessages({ account_slug, messages: [...] })`
 *
 * It RETURNS them. It writes NOTHING — no Convex mutation, no Hygglo write, no
 * Trigger enqueue. This is the assembler the Phase-2 poller refactor will sit
 * on once field-parity is proven (see scripts/parity-dryrun.ts).
 *
 * PARITY-CRITICAL batch-level fields the pure mappers DON'T compute (added here,
 * mirroring poll-hygglo.ts run() L712-776):
 *   - `account_slug`         — injected per row from the polled account.
 *   - `order_step_extracted` — pre-extracted active step from order.steps[],
 *                              validated against VALID_STEP_KEYS (the poller
 *                              does this to avoid uploading the 30KB raw order
 *                              blob on the hot path).
 *   - `order`                — only forwarded on DENIAL_SIGNALS rows (the poller
 *                              strips it otherwise; the server backfills step
 *                              from `order_step_extracted`).
 *
 * Pure except for the Hygglo GETs (which are themselves read-only). Deterministic
 * given the live Hygglo responses + the injected `fetchedAt`.
 */

import { createHyggloCore, type HyggloCore } from "./index";
import type { HyggloAccount } from "./auth-account";
import { ALL_FILTERS } from "./orders";
import {
  orderToReservation,
  orderToRenter,
  orderToMessages,
  orderToConversation,
  orderToInquiryItems,
} from "./shape";
import type {
  ConversationPayload,
  HyggloOrderDetail,
  HyggloOrderStepKey,
  MessagePayload,
  RenterPayload,
  ReservationUpsertArgs,
} from "./types";

// ── Batch-build constants (VERBATIM from poll-hygglo.ts run()) ────────────

/** Denial-style system signals. The poller forwards the raw `order` blob ONLY
 *  for these rows (listing-resolver context); all other rows ship without it
 *  and the server backfills step from `order_step_extracted`. */
const DENIAL_SIGNALS = new Set<string>([
  "owner_denied",
  "renter_cancelled",
  "auto_cancelled",
  "verification_failed",
]);

/** The 10 recognised Hygglo step keys. `order_step_extracted` is only set when
 *  the active step is one of these (matches the poller + the Convex validator's
 *  union). Anything else → undefined (server falls back to extracting from the
 *  raw order, which it only receives on denial rows). */
const VALID_STEP_KEYS = new Set<string>([
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

/**
 * Extract the active order step from a raw Hygglo order detail.
 * VERBATIM from poll-hygglo.ts run()'s inline `extractStep` (L727-735):
 * looks at order.steps ?? order.detail.steps ?? order._detail.steps and returns
 * the `key` of the first step with `active === true`. Returns undefined when no
 * active step is present.
 */
function extractStep(order: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = order as any;
  const steps = o?.steps ?? o?.detail?.steps ?? o?._detail?.steps;
  if (!Array.isArray(steps)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = steps.find((s: any) => s?.active === true);
  return active?.key;
}

/**
 * True when Hygglo's order `actions` map currently offers accept/deny — i.e. the
 * request is awaiting the OWNER's approval (the trigger shown at the top of the
 * messages board). Returns undefined when no actions map is present (so the
 * consumer keeps its order_step==="REQUEST" fallback rather than forcing false).
 */
function extractAwaitingOwnerAction(order: unknown): boolean | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = order as any;
  const actions = o?.actions ?? o?.detail?.actions ?? o?._detail?.actions;
  if (!actions || typeof actions !== "object") return undefined;
  return (
    actions.accept === true ||
    actions.deny === true ||
    actions.provideVehicleInfoAndAccept === true
  );
}

/**
 * Granular owner actions from the same `actions` map (2026-06-26). Lets Quick
 * Reply distinguish a NEW request (accept available) from one already approved
 * (accept gone, only deny). Returns {} when the order has no actions map so the
 * consumer keeps any existing/derived state rather than forcing false.
 */
function extractOwnerActions(order: unknown): { can_accept?: boolean; can_deny?: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = order as any;
  const actions = o?.actions ?? o?.detail?.actions ?? o?._detail?.actions;
  if (!actions || typeof actions !== "object") return {};
  return {
    can_accept: actions.accept === true || actions.provideVehicleInfoAndAccept === true,
    can_deny: actions.deny === true,
  };
}

// ── Result shape ─────────────────────────────────────────────────────────

export interface CorePollResult {
  /** Args ready for `upsertOrdersAsReservationsBatch({ orders })`. */
  reservations: ReservationUpsertArgs[];
  /** Args ready for `upsertRentersBatch({ account_slug, renters })`. */
  renters: RenterPayload[];
  /** Args ready for `upsertConversationsBatch({ account_slug, conversations })`. */
  conversations: ConversationPayload[];
  /** Args ready for `upsertMessages({ account_slug, messages })`. */
  messages: MessagePayload[];
  /** Phase 18.2 — every order confirmed present this cycle, whether its detail
   *  was freshly fetched (has a row in `reservations`) or its fetch was SKIPPED
   *  because nothing changed (`activityStampUnchanged`). This is the correct
   *  source for "is this order still on Hygglo's current list" — unlike
   *  `reservations`, it is NOT reduced by the skip-fetch optimisation, so
   *  hygglo_presence.replaceCurrentOrders / Return Hub freshness stays accurate
   *  even when most orders this cycle were skipped. Excludes orders whose
   *  detail GET failed (unknown state) and date-less orders with no
   *  reservation payload, matching pre-existing currentOrderIds semantics. */
  presentOrderIds: Array<{ id: string; sourceFilter: string }>;
  /** Diagnostics (NOT sent to any mutation). */
  meta: {
    account_slug: string;
    orders_listed: number;
    orders_with_detail: number;
    reservation_rows: number;
    fetched_at: number;
    /** B4 — count of `listOrders(filter)` calls that threw (non-fatal, skipped).
     *  >0 means this cycle saw fewer orders than Hygglo actually has. */
    list_filter_errors: number;
    /** B4 — count of per-order `getOrder(id)` detail GETs that threw (non-fatal,
     *  skipped). >0 means some listed orders were not refreshed this cycle. */
    detail_fetch_errors: number;
    /** Phase 18.2 — count of orders whose detail GET was skipped because
     *  `activityStampUnchanged` proved nothing changed since the stored row.
     *  0 whenever `opts.getStoredActivity` is omitted. */
    orders_skipped_unchanged: number;
    mode: CorePollMode;
    orders_selected: number;
  };
}

export type CorePollMode = "full" | "operational";

const DEFAULT_OPERATIONAL_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_OPERATIONAL_MAX_ORDERS = 24;
const UNKNOWN_ACTIVITY_PER_FILTER = 2;
const OPERATIONAL_MESSAGES_PER_ORDER = 8;

/** Hygglo has returned this field as epoch seconds, epoch milliseconds and ISO. */
export function parseLatestActivityMs(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

type ListedOrder = {
  id: number;
  sourceFilter: string;
  latest_activity?: number | string;
};

/** Mirror of `getLatestActivityBatch`'s return-map value (convex/hygglo.ts). */
export interface StoredActivityEntry {
  latest_activity: number | string;
  has_order_step: boolean;
}

/**
 * Injected by the caller (poll-hygglo.ts) to fetch each candidate order's
 * stored `latest_activity` + order_step presence from Convex in ONE batched
 * call (`api.hygglo.getLatestActivityBatch`). corePoll stays Convex-free by
 * construction — same dependency-injection pattern as `core` (HyggloCore)
 * above — so tests / parity-dryrun / manual-poll can omit it and keep fetching
 * every order's detail unconditionally.
 */
export type StoredActivityLookup = (
  hygglo_order_ids: string[],
) => Promise<Record<string, StoredActivityEntry>>;

/**
 * Phase 18.2 skip-fetch decision. True ONLY when both the stored (last-write)
 * and freshly-listed `latest_activity` stamps are present and resolve to the
 * identical instant. Any parse failure, undefined value, or mismatch returns
 * false — the caller MUST then fetch. Never guess: a false positive here would
 * mean a real Hygglo change (new message, step transition, status change,
 * price update) silently never reaches Convex, which is worse than the extra
 * API call this optimisation is trying to save.
 */
export function activityStampUnchanged(
  stored: number | string | undefined,
  listed: number | string | undefined,
): boolean {
  if (stored === undefined || listed === undefined) return false;
  const storedMs = parseLatestActivityMs(stored);
  const listedMs = parseLatestActivityMs(listed);
  if (storedMs !== null && listedMs !== null) return storedMs === listedMs;
  // One or both sides didn't parse as a timestamp (Hygglo has been observed to
  // return this field as epoch seconds, epoch ms, or ISO text — see the
  // parseLatestActivityMs docstring). Only trust an exact raw match in that
  // case; anything else must fetch rather than guess.
  return stored === listed;
}

/**
 * Keep quick refreshes bounded while never depending on one timestamp format.
 * Fresh activity is the primary signal; a tiny per-filter fallback protects
 * new/changed rows when Hygglo omits or changes latest_activity.
 */
export function selectOperationalOrders(
  orders: ListedOrder[],
  fetchedAt: number,
  windowMs = DEFAULT_OPERATIONAL_WINDOW_MS,
  maxOrders = DEFAULT_OPERATIONAL_MAX_ORDERS,
): ListedOrder[] {
  const cutoff = fetchedAt - windowMs;
  const unknownByFilter = new Map<string, number>();
  const eligible = orders.filter((order) => {
      const activity = parseLatestActivityMs(order.latest_activity);
      if (activity !== null) return activity >= cutoff;
      const used = unknownByFilter.get(order.sourceFilter) ?? 0;
      if (used >= UNKNOWN_ACTIVITY_PER_FILTER) return false;
      unknownByFilter.set(order.sourceFilter, used + 1);
      return true;
    });

  // listOrders is grouped by filter. A simple slice lets a busy pending bucket
  // consume the whole cap and starve a fresh reply/payment in current/future.
  // Round-robin the already activity-sorted buckets for consistent coverage.
  const buckets = new Map<string, ListedOrder[]>();
  for (const order of eligible) {
    const bucket = buckets.get(order.sourceFilter) ?? [];
    bucket.push(order);
    buckets.set(order.sourceFilter, bucket);
  }
  const selected: ListedOrder[] = [];
  const cap = Math.max(0, maxOrders);
  for (let index = 0; selected.length < cap; index++) {
    let added = false;
    for (const bucket of buckets.values()) {
      const order = bucket[index];
      if (!order) continue;
      selected.push(order);
      added = true;
      if (selected.length >= cap) break;
    }
    if (!added) break;
  }
  return selected;
}

export function selectOperationalMessages(
  messages: MessagePayload[],
  maxMessages = OPERATIONAL_MESSAGES_PER_ORDER,
): MessagePayload[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      // Missing timestamps are retained first: a newly introduced Hygglo label
      // format must not make a fresh reply invisible.
      if (a.message.hygglo_sent_at === undefined && b.message.hygglo_sent_at !== undefined) return -1;
      if (a.message.hygglo_sent_at !== undefined && b.message.hygglo_sent_at === undefined) return 1;
      return (b.message.hygglo_sent_at ?? 0) - (a.message.hygglo_sent_at ?? 0) || b.index - a.index;
    })
    .slice(0, Math.max(0, maxMessages))
    .map(({ message }) => message);
}

// ── corePoll ─────────────────────────────────────────────────────────────

/**
 * Run the full read-only poll for one account and assemble every upsert payload
 * the live poller would build. Writes nothing.
 *
 * Sequence (mirrors poll-hygglo.ts):
 *   1. listAllOrders across {pending,current,future,obsolete}, dedup first-seen.
 *      (Done via the core's `listOrders` per filter so the dedup order is the
 *      poller's pending→current→future→obsolete.)
 *   2. For each unique order: getOrder(id) detail.
 *   3. Run the pure mappers → reservation / renter / messages / conversation.
 *   4. Append the batch-level fields (account_slug, order_step_extracted,
 *      conditional order) to each reservation arg.
 *
 * `fetchedAt` defaults to one Date.now() for the whole cycle (the poller uses a
 * single timestamp per scrape — see poll-hygglo.ts L371). Override for
 * deterministic tests/fixtures.
 *
 * NOTE on the skip-fetch optimisation (Phase 18.2, wired 2026-08-18): when the
 * caller supplies `opts.getStoredActivity`, corePoll fetches each candidate
 * order's stored `latest_activity` + order_step presence from Convex in ONE
 * batched call, then skips the per-order detail GET whenever Hygglo's freshly
 * listed `latest_activity` matches the stored value AND the stored row already
 * has order_step (see `activityStampUnchanged`). This is a Convex-read-driven
 * cost optimisation, NOT a shaping step — it changes WHICH orders get refreshed
 * this cycle, never the SHAPE of a refreshed row, and it NEVER guesses: a
 * missing/unparseable/mismatched stamp, a legacy row with no order_step yet, or
 * a lookup failure all fall through to a real fetch (see `activityStampUnchanged`
 * and the try/catch around the batched call). Skipped orders are still recorded
 * as present via `presentOrderIds` so hygglo_presence / Return Hub freshness
 * tracking is unaffected by the skip.
 *
 * `opts.getStoredActivity` is intentionally omitted by parity-dryrun.ts (which
 * must fetch every order's detail to prove field parity), manual-poll.ts (an
 * emergency full refresh should always be thorough), and every test in
 * poll.test.ts — for all of them the assembled payload for any given order is
 * byte-identical to before this optimisation existed. Only poll-hygglo.ts (the
 * live scheduled poller) supplies the lookup.
 */
export async function corePoll(
  accountInput: HyggloAccount | string,
  opts: {
    fetchedAt?: number;
    core?: HyggloCore;
    mode?: CorePollMode;
    operationalWindowMs?: number;
    operationalMaxOrders?: number;
    /** Phase 18.2 — when supplied, enables the skip-fetch optimisation (see
     *  the corePoll docstring's NOTE). Omit to always fetch every order's
     *  detail (tests / parity-dryrun / manual-poll all omit it). */
    getStoredActivity?: StoredActivityLookup;
  } = {},
): Promise<CorePollResult> {
  const core = opts.core ?? createHyggloCore(accountInput);
  const account_slug = core.account.slug;
  const fetchedAt = opts.fetchedAt ?? Date.now();
  const mode = opts.mode ?? "full";

  // B4 — per-order/per-filter failures are non-fatal (a flaky filter or a
  // single bad detail GET must not abort the whole account), but they must NOT
  // be silently swallowed: we log each with context AND tally them so the count
  // surfaces in `meta` (and from there into the poller's logs / sync_state).
  let listFilterErrors = 0;
  let detailFetchErrors = 0;

  // 1. List + dedup across all four filters (first-seen filter wins).
  const seen = new Set<number>();
  const uniqueOrders: Array<{
    id: number;
    sourceFilter: string;
    latest_activity?: number | string;
  }> = [];
  for (const filter of ALL_FILTERS) {
    let listed;
    try {
      listed = await core.listOrders(filter);
    } catch (err) {
      // Mirror poll-hygglo: a failed filter is skipped, not fatal — but logged
      // + counted (B4), never swallowed.
      listFilterErrors++;
      console.error(
        `[corePoll] listOrders failed account=${account_slug} filter=${filter}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    for (const o of listed) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      uniqueOrders.push({
        id: o.id,
        sourceFilter: o.sourceFilter,
        latest_activity: o.latest_activity,
      });
    }
  }

  const selectedOrders = mode === "operational"
    ? selectOperationalOrders(
        uniqueOrders,
        fetchedAt,
        opts.operationalWindowMs,
        opts.operationalMaxOrders,
      )
    : uniqueOrders;

  const reservations: ReservationUpsertArgs[] = [];
  const renterMap = new Map<string, RenterPayload>();
  const conversations: ConversationPayload[] = [];
  const messages: MessagePayload[] = [];
  const presentOrderIds: Array<{ id: string; sourceFilter: string }> = [];
  let ordersWithDetail = 0;
  let ordersSkippedUnchanged = 0;

  // Phase 18.2 — one batched Convex read for every candidate order's stored
  // latest_activity + order_step presence. A lookup failure degrades to "fetch
  // everything" (empty map), never to a false skip — see the try/catch below
  // and `activityStampUnchanged`'s conservative semantics.
  let storedActivity: Record<string, StoredActivityEntry> = {};
  if (opts.getStoredActivity && selectedOrders.length > 0) {
    try {
      storedActivity = await opts.getStoredActivity(
        selectedOrders.map((o) => String(o.id)),
      );
    } catch (err) {
      console.error(
        `[corePoll] getStoredActivity batch lookup failed account=${account_slug}: ${
          err instanceof Error ? err.message : String(err)
        } — fetching every order's detail this cycle`,
      );
      storedActivity = {};
    }
  }

  // 2-4. Per-order detail fetch → mappers → batch-level field append.
  for (const order of selectedOrders) {
    const stored = storedActivity[String(order.id)];
    if (
      stored?.has_order_step === true &&
      activityStampUnchanged(stored.latest_activity, order.latest_activity)
    ) {
      // Hygglo's own list-endpoint activity stamp matches what we stored the
      // last time we fetched this order's detail, AND that stored row already
      // has an order_step (so we are not backfilling a legacy pre-Phase-18.2
      // row). Nothing about this order — status, messages, steps, price — can
      // have changed since then, so the detail GET+parse is skipped. The order
      // is still recorded as present (presentOrderIds) for hygglo_presence /
      // Return Hub freshness; it is deliberately NOT re-added to
      // reservations/messages/conversations/renters since there is nothing new
      // to write.
      ordersSkippedUnchanged++;
      presentOrderIds.push({ id: String(order.id), sourceFilter: order.sourceFilter });
      continue;
    }

    let detail: HyggloOrderDetail;
    try {
      detail = await core.getOrder(order.id);
    } catch (err) {
      // Mirror poll-hygglo: a failed detail GET (`!detailRes.ok`) is skipped —
      // but logged + counted (B4), never swallowed.
      detailFetchErrors++;
      console.error(
        `[corePoll] getOrder failed account=${account_slug} order_id=${order.id} filter=${order.sourceFilter}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    ordersWithDetail++;

    // ── renter (dedup by hygglo_user_id ?? lowercased name) ──
    const renter = orderToRenter(detail);
    const renterKey =
      renter.hygglo_user_id ?? renter.display_name.trim().toLowerCase();
    if (!renterMap.has(renterKey)) renterMap.set(renterKey, renter);

    // ── messages + conversation ──
    const orderMessages = orderToMessages(detail, fetchedAt);
    messages.push(...(
      mode === "operational"
        ? selectOperationalMessages(orderMessages)
        : orderMessages
    ));
    const conversation = orderToConversation(detail, fetchedAt);
    if (conversation) conversations.push(conversation);

    // ── reservation (null when rentalPeriod dates absent — poller skips) ──
    const payload = orderToReservation(
      detail,
      order.sourceFilter,
      order.latest_activity,
    );
    if (!payload) {
      // Date-less inquiry: no reservation row will be built, so the order's
      // `detail.items[]` (the listing the renter is asking about + its image)
      // would be discarded and the Reply Inbox tile left blank. Snapshot the
      // product onto the conversation so `assembleTile` can fall back to it.
      if (conversation) {
        const snapshot = orderToInquiryItems(detail);
        if (snapshot.inquiry_items) {
          conversation.inquiry_items = snapshot.inquiry_items;
          conversation.inquiry_image_url = snapshot.inquiry_image_url;
        }
      }
      continue;
    }

    // ── batch-level fields (poll-hygglo.ts run() L741-776) ──
    // B3 — `order_step_extracted` MUST be defined on every active-step row.
    // corePoll strips `order` to {} on the non-denial hot path, so the
    // consumer's `?? extractStep(order)` fallback would resolve undefined; we
    // are the sole place the step can be derived. `extractStep` returns the
    // active step key whenever the order carries one (any of the three
    // step-array shapes). We forward it for every RECOGNISED key, which is the
    // server's accepted union (convex/hygglo.ts:VALID_ORDER_STEPS) — an
    // unrecognised active step is the one case the server itself maps to
    // undefined (with a warning), so we mirror that rather than invent a key.
    const stepRaw = extractStep(payload.order);
    const order_step_extracted: HyggloOrderStepKey | undefined =
      stepRaw && VALID_STEP_KEYS.has(stepRaw)
        ? (stepRaw as HyggloOrderStepKey)
        : undefined;
    const needsRawOrder = DENIAL_SIGNALS.has(payload.hygglo_system_signal ?? "");
    const awaitingOwnerAction = extractAwaitingOwnerAction(payload.order);
    const ownerActions = extractOwnerActions(payload.order);

    reservations.push({
      account_slug,
      hygglo_order_id: payload.hygglo_order_id,
      status: payload.status,
      start_date: payload.start_date,
      end_date: payload.end_date,
      gross_paid_gbp: payload.gross_paid_gbp,
      net_to_owner_gbp: payload.net_to_owner_gbp,
      currency: payload.currency,
      items: payload.items,
      duration_days: payload.duration_days,
      ...(needsRawOrder && { order: payload.order }),
      // B2 — always carry the full detail blob for the listing resolver's
      // `hygglo_detail_payload`. Distinct from `order` (stripped on non-denial
      // rows for upload bandwidth); never sent to the upsert mutation.
      detail_payload: payload.order,
      ...(order_step_extracted && { order_step_extracted }),
      ...(awaitingOwnerAction !== undefined && {
        awaiting_owner_action: awaitingOwnerAction,
      }),
      ...(ownerActions.can_accept !== undefined && { can_accept: ownerActions.can_accept }),
      ...(ownerActions.can_deny !== undefined && { can_deny: ownerActions.can_deny }),
      sourceFilter: payload.sourceFilter,
      renter_name: payload.renter_name,
      hygglo_user_id: payload.hygglo_user_id,
      booking_status: payload.booking_status,
      pickup_time: payload.pickup_time,
      return_time: payload.return_time,
      pickup_method: payload.pickup_method,
      return_method: payload.return_method,
      notes: payload.notes,
      photos_urls: payload.photos_urls,
      latest_activity: payload.latest_activity,
      hygglo_system_signal: payload.hygglo_system_signal,
      hygglo_system_signal_text: payload.hygglo_system_signal_text,
    });
    presentOrderIds.push({ id: payload.hygglo_order_id, sourceFilter: order.sourceFilter });
  }

  return {
    reservations,
    renters: Array.from(renterMap.values()),
    conversations,
    messages,
    presentOrderIds,
    meta: {
      account_slug,
      orders_listed: uniqueOrders.length,
      orders_with_detail: ordersWithDetail,
      reservation_rows: reservations.length,
      fetched_at: fetchedAt,
      list_filter_errors: listFilterErrors,
      detail_fetch_errors: detailFetchErrors,
      orders_skipped_unchanged: ordersSkippedUnchanged,
      mode,
      orders_selected: selectedOrders.length,
    },
  };
}
