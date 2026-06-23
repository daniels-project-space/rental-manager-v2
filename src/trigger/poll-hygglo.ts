/**
 * poll-hygglo-inbox — Phase 6.1
 *
 * Runs every 5 minutes. Pulls Hygglo credentials from the project-hub vault,
 * authenticates to the Hygglo REST API (read-only) for each account,
 * extracts chat messages from active orders, and upserts into Convex.
 * Phase 6.1: also populates renters + conversations tables.
 *
 * READ-ONLY on Hygglo: only GET requests after auth. No mutations sent to Hygglo.
 */
import { schedules, logger, tasks } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { deriveListingInfoPoolOnDemandTask } from "./derive-listing-info-pool";
import { computeHoldsForReservations } from "../lib/reconcile-holds";
import { isOutsidePollActiveWindow } from "../lib/quiet-hours";
// Phase 2 (corePoll cutover complete) — the pure hygglo-core poll assembler is
// now the SOLE fetch+shape path. It produces the `{ messages, reservations,
// renters, conversations }` payload arrays consumed by downstream (B) — Convex
// upserts, holds reconcile, sync_state, listing resolution. The legacy inline
// `scrapeAccount` scraper and its `use_core_poll` feature flag were removed
// after corePoll was validated in production (Phase 2 cleanup).
import { corePoll } from "../hygglo-core/poll";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
// Fallback URL must match v2's active deployment (see .env.local NEXT_PUBLIC_CONVEX_URL).
// Wrong fallback caused poll writes to hit exciting-lion-29 while the dashboard
// read from hearty-oyster-600 — renter_name/order_step/photos_urls never landed.
const CONVEX_URL = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Vault helper ──────────────────────────────────────────────

interface VaultSecret {
  keyName: string;
  value: string;
}

async function getVaultSecrets(service: string): Promise<Record<string, string>> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  const data = (await res.json()) as { value: VaultSecret[] };
  const out: Record<string, string> = {};
  for (const s of data.value ?? []) out[s.keyName] = s.value;
  return out;
}

// ── Hygglo API types ──────────────────────────────────────────

type Activity = {
  key: string;
  chatMessage?: { text?: { content?: string }; byMe?: boolean };
  /** Phase 3d — Hygglo system events ("blue text"). The poller previously
   *  ignored this; we now derive `hygglo_system_signal` from it. */
  event?: { title?: string; content?: string };
  createdAtLabel?: string;
};

/** Phase 3d — derive the most-recent decisive Hygglo system signal.
 *  B5: MOVED to the canonical `hygglo-core/signals` module (was triplicated).
 *  Re-exported here so any external `./poll-hygglo` consumer keeps working. */
export { deriveHyggloSystemSignal } from "../hygglo-core/signals";

type OrderDetail = {
  id: number;
  activities?: Activity[];
  users?: { otherPart?: { name?: string; id?: number | string } };
  labels?: { otherPart?: string };
  rentalPeriod?: { startDateUTC?: string; endDateUTC?: string };
  price?: {
    currency?: string;
    total?: number;
    ownerEarnings?: number;
    breakdown?: {
      totalPrice?: { amount?: number };
      lenderEarnings?: { amount?: number };
    };
  };
  items?: Array<{ name?: string; type?: string }>;
  /** Steps array — present on the per-order detail endpoint (/v4/my/orders/:id). */
  steps?: Array<{ key: string; active?: boolean; completed?: boolean; failure?: boolean }>;
};

type OrderReservationPayload = {
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: Array<{
    item_name: string;
    qty?: number;
    image?: {
      url?: string;
      originalUrl?: string;
      largeUrl?: string;
      mediumUrl?: string;
      thumbnailUrl?: string;
      fullSizeUrl?: string;
    };
    type?: string;
    product_id?: number;
    slug?: string;
  }>;
  duration_days?: number;
  sourceFilter: string;
  renter_name?: string;
  /** 2026-05-19 — Hygglo renter user id (detail.users.otherPart.id). Forwarded
   *  to upsertOrderAsReservation so the mutation can resolve renter_id. */
  hygglo_user_id?: string;
  /** Raw Hygglo booking status (e.g. "pending_review") extracted from detail.booking.status. */
  booking_status?: string;
  /** Calendar UI fields — extracted from detail.booking.* and detail.* */
  pickup_time?: string;
  return_time?: string;
  pickup_method?: string;
  return_method?: string;
  notes?: string;
  photos_urls?: string[];
  /** Phase 18.2 — list-endpoint activity stamp; persisted so the next poll
   *  can skip the detail fetch when unchanged. */
  latest_activity?: number | string;
  /** Raw detail object from /v4/my/orders/:id — carries `steps[]` for order_step extraction. */
  order: OrderDetail;
  /** B2 — full per-order detail blob, ALWAYS populated by corePoll (unlike
   *  `order`, which is `{}` on non-denial rows). Feeds the listing resolver's
   *  `hygglo_detail_payload` for newly-inserted listings. Never sent to the
   *  upsert mutation. */
  detail_payload?: OrderDetail;
  /** corePoll forwards a pre-extracted active step here; the batch-build loop
   *  uses it verbatim instead of re-deriving from `order` (which corePoll strips
   *  on non-denial rows). When undefined the loop falls through to its existing
   *  `extractStep(order)` derivation. */
  order_step_extracted?:
    | "REQUEST" | "APPROVED" | "FUNDS_RESERVED" | "VERIFIED"
    | "BOOKED_AFTER_VERIFIED" | "DELIVERED" | "RETURNED" | "REVIEWED"
    | "CANCELED" | "VERIFICATION_FAILED";
  /** 2026-06-23 — Hygglo actions map offers accept/deny (awaiting owner approval). */
  awaiting_owner_action?: boolean;
  /** Phase 3d — derived from activity.event.content. */
  hygglo_system_signal?:
    | "owner_denied"
    | "renter_cancelled"
    | "auto_cancelled"
    | "verification_failed"
    | "approved"
    | "none";
  hygglo_system_signal_text?: string;
};

// ── core-poll adapter (Phase 2 — sole fetch+shape path) ───────
//
// Produces the `{ messages, reservations, renters, conversations }` shape that
// downstream (B) consumes, sourcing it from the parity-proven `corePoll(slug)`
// assembler.
//
// corePoll returns `reservations` already in `upsertOrdersAsReservationsBatch`
// arg shape (incl. batch-level `account_slug` + `order_step_extracted`, and the
// `order` blob retained ONLY on denial rows — the parity work proved this 0-delta
// vs stored rows). We map those back onto `OrderReservationPayload[]` so the (B)
// batch-build loop is unchanged. The loop's `extractStep(order)` would yield
// undefined on the non-denial rows where corePoll stripped `order`; to preserve
// parity we forward corePoll's pre-extracted step via `order_step_extracted`,
// which the loop prefers (see the `??` in run()). credentials/auth/vault are
// resolved inside corePoll → createHyggloCore, so we pass only the slug.
//
// KNOWN BEHAVIOUR: on non-denial NEWLY-INSERTED rows the
// `newlyInserted[].hygglo_detail_payload` (best-effort listing-resolver context,
// never a money field) is undefined because corePoll strips `order` off the
// hot path. This only affects brand-new-listing enrichment, not
// reservation/revenue data.
async function scrapeAccountViaCore(accountSlug: string): Promise<{
  messages: Array<{
    thread_id: string;
    message_id: string;
    sender: string;
    sender_name?: string;
    body_text: string;
    hygglo_sent_at?: number;
    fetched_at: number;
  }>;
  reservations: OrderReservationPayload[];
  renters: Array<{ hygglo_user_id?: string; display_name: string }>;
  conversations: Array<{
    thread_id: string;
    hygglo_user_id?: string;
    display_name: string;
    last_msg_at: number;
    created_at: number;
  }>;
}> {
  const core = await corePoll(accountSlug, { fetchedAt: Date.now() });

  // B4 — surface non-fatal per-filter / per-order fetch failures that corePoll
  // counted (instead of swallowing them silently). A non-zero count means this
  // cycle saw / refreshed fewer orders than Hygglo actually has.
  if (core.meta.list_filter_errors > 0 || core.meta.detail_fetch_errors > 0) {
    logger.warn("[poll-hygglo] corePoll had non-fatal fetch failures", {
      account: accountSlug,
      list_filter_errors: core.meta.list_filter_errors,
      detail_fetch_errors: core.meta.detail_fetch_errors,
    });
  }

  const reservations: OrderReservationPayload[] = core.reservations.map((r) => ({
    hygglo_order_id: r.hygglo_order_id,
    status: r.status,
    start_date: r.start_date,
    end_date: r.end_date,
    gross_paid_gbp: r.gross_paid_gbp,
    net_to_owner_gbp: r.net_to_owner_gbp,
    currency: r.currency,
    items: r.items as OrderReservationPayload["items"],
    duration_days: r.duration_days,
    sourceFilter: r.sourceFilter ?? "",
    renter_name: r.renter_name,
    hygglo_user_id: r.hygglo_user_id,
    booking_status: r.booking_status,
    pickup_time: r.pickup_time,
    return_time: r.return_time,
    pickup_method: r.pickup_method,
    return_method: r.return_method,
    notes: r.notes,
    photos_urls: r.photos_urls,
    latest_activity: r.latest_activity,
    // `order` is retained by corePoll only on denial rows; default to {} so the
    // (B) loop's `needsRawOrder && { order }` upsert read mirrors corePoll's
    // bandwidth design. The step is forwarded explicitly below.
    order: (r.order ?? {}) as OrderDetail,
    // B2 — full detail blob corePoll always carries; consumed by the listing
    // resolver via `hygglo_detail_payload` (fixes the empty-{} regression on the
    // common non-denial newly-inserted path). Falls back to `order` then {}.
    detail_payload: (r.detail_payload ?? r.order ?? {}) as OrderDetail,
    order_step_extracted: r.order_step_extracted,
    awaiting_owner_action: r.awaiting_owner_action,
    hygglo_system_signal: r.hygglo_system_signal,
    hygglo_system_signal_text: r.hygglo_system_signal_text,
  }));

  return {
    messages: core.messages,
    reservations,
    renters: core.renters,
    conversations: core.conversations,
  };
}

// ── Task ──────────────────────────────────────────────────────

export const pollHyggloInbox = schedules.task({
  id: "poll-hygglo-inbox",
  cron: "*/15 * * * *",
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    if (isOutsidePollActiveWindow()) {
      // Heartbeat: keep dashboard "fresh" indicator alive outside the active window.
      try {
        const hbConvex = new ConvexHttpClient(CONVEX_URL);
        await hbConvex.mutation(api.sync_state.recordSyncRun, {
          source: "hygglo_poller",
          succeeded: true,
          kind: "heartbeat",
        });
      } catch (err) {
        console.warn("[poll-hygglo] heartbeat write failed:", err);
      }
      logger.info("[poll-active-window] skipped", { task: "poll-hygglo-inbox" });
      return { skipped: true, reason: "outside_poll_active_window" };
    }
    const runStart = Date.now();
    let runSucceeded = false;
    let runError: string | undefined;

    // Aggregate counts across all accounts for sync_state
    let totalReservationsUpserted = 0;
    let totalHyggloMessagesUpserted = 0;
    let totalRentersUpserted = 0;
    let totalConversationsUpserted = 0;

    const hyggloSecrets = await getVaultSecrets("hygglo");

    const accounts = [
      {
        slug: "dbcinema",
        email: hyggloSecrets["HYGGLO_DBCINEMA_EMAIL"] ?? "",
        password: hyggloSecrets["HYGGLO_DBCINEMA_PASSWORD"] ?? "",
      },
      {
        slug: "leo",
        email: hyggloSecrets["HYGGLO_LEO_EMAIL"] ?? "",
        password: hyggloSecrets["HYGGLO_LEO_PASSWORD"] ?? "",
      },
      {
        slug: "diogo",
        email: hyggloSecrets["HYGGLO_DIOGO_EMAIL"] ?? "",
        password: hyggloSecrets["HYGGLO_DIOGO_PASSWORD"] ?? "",
      },
    ];

    const convex = new ConvexHttpClient(CONVEX_URL);

    // Phase 2 cleanup — corePoll is now the sole fetch+shape engine. The
    // `use_core_poll` feature flag and the legacy inline scraper were removed
    // after corePoll was validated in production.
    console.log("[poll-hygglo] poll engine: core-poll");

    const results: Array<{
      slug: string;
      ok: boolean;
      messages?: number;
      inserted?: number;
      renters_upserted?: number;
      conversations_upserted?: number;
      error?: string;
    }> = [];

    try {
      for (const account of accounts) {
        if (!account.email || !account.password) {
          console.warn(`[poll-hygglo] Missing creds for ${account.slug}, skipping`);
          results.push({ slug: account.slug, ok: false, error: "missing_creds" });
          continue;
        }

        // ── Paused-mode guard ──────────────────────────────────
        try {
          const accountState = await convex.query(api.account_state.get, { account: account.slug });
          if (accountState?.mode === "paused") {
            console.warn(
              `[poll-hygglo] Account ${account.slug} is paused (consecutiveFailures=${accountState.consecutiveFailures}); skipping poll`
            );
            results.push({ slug: account.slug, ok: true, messages: 0, inserted: 0 });
            continue;
          }
        } catch (stateErr) {
          console.error(`[poll-hygglo] Failed to fetch account_state for ${account.slug}:`, stateErr);
          // Non-fatal: proceed with poll
        }

        try {
          // (A) FETCH + SHAPE — corePoll is the sole engine. It yields the
          // `{ messages, reservations, renters, conversations }` shape that
          // everything below (B) consumes unchanged. corePoll always fetches
          // detail (no skip-detail optimization), which the production soak
          // proved acceptable.
          const { messages, reservations, renters, conversations } =
            await scrapeAccountViaCore(account.slug);

          // Upsert chat messages (batched 50)
          let totalInserted = 0;
          let totalSkipped = 0;
          for (let i = 0; i < messages.length; i += 50) {
            const batch = messages.slice(i, i + 50);
            const r = await convex.mutation(api.hygglo.upsertMessages, {
              account_slug: account.slug,
              messages: batch,
            });
            totalInserted += r.inserted;
            totalSkipped += r.skipped;
          }
          totalHyggloMessagesUpserted += totalInserted;

          // Upsert reservations in a single mutation per chunk. Convex cost rule
          // (CLAUDE.md): "one mutation per cron run, not per row". We chunk at 50
          // to stay under the per-call payload limit, which still drops ~100
          // per-order mutations down to ~2-3 batch calls per account per cycle.
          let resInserted = 0;
          let resUpdated = 0;
          const newlyInserted: Array<{
            reservation_id: string;
            hygglo_order_id: string;
            hygglo_title: string;
            hygglo_description?: string;
            hygglo_detail_payload?: unknown;
            image_url?: string;
          }> = [];
          // Per-item info-pool targets harvested from newly-inserted
          // reservations. De-duped by (account, product_id) inside the
          // loop; fired as a single tasks.trigger() call after upserts
          // complete.
          const infoPoolTargets = new Map<
            string,
            { account_slug: string; product_id: number; raw_title: string }
          >();

          for (let i = 0; i < reservations.length; i += 50) {
            const batch = reservations.slice(i, i + 50);
            // Pass 13b (2026-05-26): pre-extract order_step + drop the raw
            // `order` blob on the common (non-denial) path. The ~30KB
            // Hygglo JSON was uploaded for every row × 288 polls/day even
            // though server only used it to read a single step string. Only
            // denial transitions need the full payload (for listing
            // resolution context). ~95% of polled rows are non-denial =>
            // ~95% upload-bandwidth reduction on this mutation.
            const DENIAL_SIGNALS = new Set([
              "owner_denied",
              "renter_cancelled",
              "auto_cancelled",
              "verification_failed",
            ]);
            const extractStep = (order: unknown): string | undefined => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const o = order as any;
              const steps = o?.steps ?? o?.detail?.steps ?? o?._detail?.steps;
              if (!Array.isArray(steps)) return undefined;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const active = steps.find((s: any) => s?.active === true);
              return active?.key;
            };
            const VALID_STEP_KEYS = new Set([
              "REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED",
              "BOOKED_AFTER_VERIFIED", "DELIVERED", "RETURNED", "REVIEWED",
              "CANCELED", "VERIFICATION_FAILED",
            ]);
            const orderArgs = batch.map((payload) => {
              // Phase 2 live-flip: prefer a pre-extracted step when the core-poll
              // adapter supplied one (it strips `order` off the hot path so the
              // re-derivation below would yield undefined). The legacy inline
              // path leaves `order_step_extracted` undefined ⇒ this falls through
              // to the original `extractStep(order)` derivation, byte-identical.
              const stepRaw = extractStep(payload.order);
              const orderStepExtracted = payload.order_step_extracted ?? (
                stepRaw && VALID_STEP_KEYS.has(stepRaw)
                ? (stepRaw as "REQUEST" | "APPROVED" | "FUNDS_RESERVED" | "VERIFIED"
                  | "BOOKED_AFTER_VERIFIED" | "DELIVERED" | "RETURNED" | "REVIEWED"
                  | "CANCELED" | "VERIFICATION_FAILED")
                : undefined);
              const needsRawOrder = DENIAL_SIGNALS.has(payload.hygglo_system_signal ?? "");
              return {
                account_slug: account.slug,
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
                ...(orderStepExtracted && { order_step_extracted: orderStepExtracted }),
                ...(payload.awaiting_owner_action !== undefined && { awaiting_owner_action: payload.awaiting_owner_action }),
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
              };
            });

            const batchResults = await convex.mutation(
              api.hygglo.upsertOrdersAsReservationsBatch,
              { orders: orderArgs },
            );

            for (let j = 0; j < batchResults.length; j++) {
              const resResult = batchResults[j];
              const payload = batch[j];
              if (resResult.action === "inserted") {
                resInserted++;
                if (resResult.reservation_id) {
                  const firstItem = payload.items[0];
                  newlyInserted.push({
                    reservation_id: resResult.reservation_id,
                    hygglo_order_id: payload.hygglo_order_id,
                    hygglo_title: firstItem?.item_name ?? payload.hygglo_order_id,
                    hygglo_description: payload.notes,
                    // B2 — use the always-populated detail blob (corePoll strips
                    // `order` to {} on non-denial rows). Fall back to `order` for
                    // safety. Fixes empty `hygglo_detail_payload` on new listings.
                    hygglo_detail_payload: payload.detail_payload ?? payload.order,
                    image_url: firstItem?.image?.fullSizeUrl ?? firstItem?.image?.largeUrl ?? firstItem?.image?.url,
                  });
                  // Harvest per-item info-pool targets. One pool row per
                  // (account, product_id); skip INSURANCE rows and items
                  // without a product_id (Hygglo "manual" items).
                  for (const it of payload.items) {
                    if (!it || it.type === "INSURANCE") continue;
                    if (typeof it.product_id !== "number") continue;
                    if (!it.item_name) continue;
                    const key = `${account.slug}#${it.product_id}`;
                    if (infoPoolTargets.has(key)) continue;
                    infoPoolTargets.set(key, {
                      account_slug: account.slug,
                      product_id: it.product_id,
                      raw_title: it.item_name,
                    });
                  }
                }
              } else if (resResult.action === "updated") resUpdated++;
            }
          }
          totalReservationsUpserted += resInserted + resUpdated;

          // Phase 18.2 — on-demand listing resolution for newly inserted reservations.
          // Calls internal.listing_resolver.resolveListing directly instead of the
          // old vision pipeline. On error, writes an "unresolved" row so audit can retry.
          if (newlyInserted.length > 0) {
            for (const entry of newlyInserted) {
              try {
                const result = await convex.action(api.listing_resolver.resolveListingPublic, {
                  hygglo_listing_id: entry.hygglo_order_id,
                  hygglo_account: account.slug,
                  hygglo_title: entry.hygglo_title,
                  hygglo_description: entry.hygglo_description,
                  hygglo_detail_payload: entry.hygglo_detail_payload,
                  image_url: entry.image_url,
                });
                logger.info("[poll-hygglo] resolveListing succeeded", {
                  account: account.slug,
                  hygglo_order_id: entry.hygglo_order_id,
                  status: result.status,
                });
              } catch (resolveErr) {
                logger.warn("[poll-hygglo] resolveListing failed — writing unresolved row", {
                  account: account.slug,
                  hygglo_order_id: entry.hygglo_order_id,
                  err: String(resolveErr),
                });
                // Preserve listing: write minimal unresolved row so audit can retry
                try {
                  await convex.mutation(api.listing_resolver_data.upsertListingResolutionPublic, {
                    hygglo_listing_id: entry.hygglo_order_id,
                    hygglo_account: account.slug,
                    hygglo_title: entry.hygglo_title,
                    hygglo_description: entry.hygglo_description,
                    hygglo_detail_payload: entry.hygglo_detail_payload,
                    image_url: entry.image_url,
                    resolved_items: [],
                    status: "unresolved",
                    attempted_tiers: [],
                  });
                } catch (fallbackErr) {
                  logger.error("[poll-hygglo] fallback upsertListingResolution failed", {
                    account: account.slug,
                    hygglo_order_id: entry.hygglo_order_id,
                    err: String(fallbackErr),
                  });
                }
              }
            }
          }

          // 2026-05-24: kick the listing_info_pool derive task for fresh
          // listings. Trigger.dev's tasks.trigger is async/fire-and-forget
          // — we don't await the run, just the enqueue. The Convex
          // mutation that used to do this in-line was deleted (LLM work
          // belongs on Trigger, per CLAUDE.md).
          if (infoPoolTargets.size > 0) {
            try {
              const handle = await tasks.trigger<typeof deriveListingInfoPoolOnDemandTask>(
                "derive-listing-info-pool-on-demand",
                { targets: Array.from(infoPoolTargets.values()) },
              );
              logger.info("[poll-hygglo] info-pool derive enqueued", {
                account: account.slug,
                target_count: infoPoolTargets.size,
                run_id: handle.id,
              });
            } catch (poolErr) {
              logger.warn("[poll-hygglo] info-pool derive enqueue failed", {
                account: account.slug,
                target_count: infoPoolTargets.size,
                err: String(poolErr),
              });
            }
          }

          // Phase 6.1: upsert renters first, then conversations
          let rentersUpserted = 0;
          if (renters.length > 0) {
            const rr = await convex.mutation(api.hygglo.upsertRentersBatch, {
              account_slug: account.slug,
              renters,
            });
            rentersUpserted = rr.upserted;
          }
          totalRentersUpserted += rentersUpserted;

          let convsUpserted = 0;
          if (conversations.length > 0) {
            const cr = await convex.mutation(api.hygglo.upsertConversationsBatch, {
              account_slug: account.slug,
              conversations,
            });
            convsUpserted = cr.upserted;
          }
          totalConversationsUpserted += convsUpserted;

          console.log(
            "[poll-hygglo] " + account.slug + ": " + String(messages.length) + " msgs, " +
            String(totalInserted) + " inserted, " + String(totalSkipped) + " skipped. " +
            "Reservations: " + String(resInserted) + " inserted, " + String(resUpdated) + " updated. " +
            "Renters: " + String(rentersUpserted) + " new. Conversations: " + String(convsUpserted) + " new."
          );

          results.push({
            slug: account.slug,
            ok: true,
            messages: messages.length,
            inserted: totalInserted,
            renters_upserted: rentersUpserted,
            conversations_upserted: convsUpserted,
          });

          // ── account_state: success ────────────────────────────
          try {
            await convex.mutation(api.account_state.upsert, { account: account.slug, succeeded: true });
          } catch (asErr) {
            console.error(`[poll-hygglo] account_state.upsert (success) failed for ${account.slug}:`, asErr);
          }

          // ── Hold reconciliation (Wave 2 T5) ──────────────────
          try {
            const [reconReservationsRaw, reconItemsRaw] = await Promise.all([
              convex.query(api.reservations.listForReconcile, { account_slug: account.slug }),
              convex.query(api.items.listForReconcile, {}),
            ]);

            // Convex rows use optional account_slug; ReservationInput requires it — filter nulls.
            // Also coerce undefined date fields to null (ReservationInput uses string | null).
            //
            // pickup_at / return_at overrides: when extract_booking_times has
            // determined that the renter agreed to pick up the evening BEFORE
            // or return the morning AFTER the booking window, we feed those
            // offset dates through to reconcile-holds so the calendar shows
            // the gear out across the full real window — not just the
            // listing's nominal start_date/end_date.
            const dateAtMs = (d?: string): number | undefined => {
              if (!d) return undefined;
              const parsed = Date.parse(d + "T00:00:00Z");
              return Number.isNaN(parsed) ? undefined : parsed;
            };
            const reconReservations = reconReservationsRaw
              .filter((r) => r.account_slug != null)
              .map((r) => {
                const startStr = r.start_date ?? undefined;
                const endStr = r.end_date ?? undefined;
                const pickupStr = (r as { pickup_date?: string }).pickup_date;
                const returnStr = (r as { return_date?: string }).return_date;
                // Only override when the offset actually extends the hold —
                // earlier pickup or later return. Equal or invalid offsets
                // fall back to the booking window (no-op).
                const pickup_at =
                  pickupStr && startStr && pickupStr < startStr
                    ? dateAtMs(pickupStr)
                    : undefined;
                const return_at =
                  returnStr && endStr && returnStr > endStr
                    ? dateAtMs(returnStr)
                    : undefined;
                return {
                  ...r,
                  _id: r._id as string,
                  account_slug: r.account_slug as string,
                  start_date: r.start_date ?? null,
                  end_date: r.end_date ?? null,
                  ...(pickup_at !== undefined && { pickup_at }),
                  ...(return_at !== undefined && { return_at }),
                };
              });

            const reconItems = reconItemsRaw.map((i) => ({
              ...i,
              _id: i._id as string,
            }));

            const result = computeHoldsForReservations({
              reservations: reconReservations,
              items: reconItems,
              today: new Date(),
              forwardCapDays: 180,
            });

            if (result.holds.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const upsertResult = await convex.mutation(api.calendar.upsertHoldsBatch, { holds: result.holds as any });
              logger.log(`[reconcile] account=${account.slug} upserted=${upsertResult.inserted}+${upsertResult.updated} skipped=${upsertResult.skipped}`);
            }

            if (result.deleteReservationIds.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const delResult = await convex.mutation(api.calendar.deleteStaleHolds, { reservation_ids: result.deleteReservationIds as any });
              logger.log(`[reconcile] account=${account.slug} deleted_stale=${delResult.deleted}`);
            }

            if (result.unmatchedItemNames.length > 0) {
              logger.warn(`[reconcile] account=${account.slug} unmatched=${result.unmatchedItemNames.length}: ${result.unmatchedItemNames.slice(0, 10).join(", ")}`);
            }

            logger.log(`[reconcile] account=${account.slug} stats: ${JSON.stringify(result.stats)}`);
          } catch (reconErr) {
            // Reconciliation failure is non-fatal — Hygglo fetch + reservation upsert succeeded
            logger.error(`[reconcile] account=${account.slug} failed (non-fatal): ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[poll-hygglo] ${account.slug} failed: ${msg}`);
          // Continue — Leo failure must not crash DB Cinema
          results.push({ slug: account.slug, ok: false, error: msg });

          // ── account_state: failure ────────────────────────────
          try {
            await convex.mutation(api.account_state.upsert, { account: account.slug, succeeded: false, errorMessage: msg });
          } catch (asErr) {
            console.error(`[poll-hygglo] account_state.upsert (failure) failed for ${account.slug}:`, asErr);
          }
        }
      }

      runSucceeded = true;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      console.error(`[poll-hygglo] Fatal error: ${runError}`);
    } finally {
      const durationMs = Date.now() - runStart;
      try {
        await convex.mutation(api.sync_state.recordSyncRun, {
          source: "hygglo_poller",
          succeeded: runSucceeded,
          durationMs,
          rowsUpserted: {
            reservations: totalReservationsUpserted,
            hygglo_messages: totalHyggloMessagesUpserted,
            renters: totalRentersUpserted,
            conversations: totalConversationsUpserted,
          },
          ...(runError ? { errorMessage: runError } : {}),
        });
      } catch (syncErr) {
        console.error("[poll-hygglo] Failed to record sync state:", syncErr);
      }
    }

    const totalInserted = results.reduce((s, r) => s + (r.inserted ?? 0), 0);
    console.log(`[poll-hygglo] Done. Total new messages inserted: ${totalInserted}`);
    return { results, totalInserted, ts: Date.now() };
  },
});
