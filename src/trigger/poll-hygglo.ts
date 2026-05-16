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
import { computeHoldsForReservations } from "../lib/reconcile-holds";
import { isWithinUkQuietHours } from "../lib/quiet-hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
// Fallback URL must match v2's active deployment (see .env.local NEXT_PUBLIC_CONVEX_URL).
// Wrong fallback caused poll writes to hit exciting-lion-29 while the dashboard
// read from hearty-oyster-600 — renter_name/order_step/photos_urls never landed.
const CONVEX_URL = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
// CLIENT_SECRET is read from vault at runtime (key: HYGGLO_CLIENT_SECRET)
const COUNTRY = "GB";

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
  createdAtLabel?: string;
};

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
};

// ── Timestamp parser ──────────────────────────────────────────

function parseCreatedAtLabel(label: string): Date | null {
  if (!label) return null;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const match = label.match(
    /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,?\s+(\d{1,2}):(\d{2}))?/
  );
  if (match) {
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const now = new Date();
    const year = now.getFullYear();
    const hours = match[3] ? parseInt(match[3], 10) : 0;
    const minutes = match[4] ? parseInt(match[4], 10) : 0;
    const date = new Date(year, month, day, hours, minutes);
    if (date.getTime() > now.getTime() + 86400000) date.setFullYear(year - 1);
    return date;
  }
  if (label.toLowerCase().startsWith("yesterday")) {
    const t = label.match(/(\d{1,2}):(\d{2})/);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    if (t) d.setHours(parseInt(t[1], 10), parseInt(t[2], 10), 0, 0);
    return d;
  }
  if (label.toLowerCase().startsWith("today")) {
    const t = label.match(/(\d{1,2}):(\d{2})/);
    const d = new Date();
    if (t) d.setHours(parseInt(t[1], 10), parseInt(t[2], 10), 0, 0);
    return d;
  }
  return null;
}

// ── Scraper ───────────────────────────────────────────────────

async function scrapeAccount(
  accountSlug: string,
  email: string,
  password: string,
  clientSecret: string,
  // Phase 18.2 — pre-fetched map of hygglo_order_id → stored latest_activity.
  // When the list response carries the same value for an order, we skip the
  // expensive per-order detail fetch.
  lookupStoredLatestActivity?: (ids: string[]) => Promise<Record<string, number | string>>,
): Promise<{
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
  // 1. Authenticate
  const tokenParams = new URLSearchParams({
    grant_type: "password",
    username: email,
    password,
    client_id: CLIENT_ID,
    client_secret: clientSecret,
  });

  const tokenRes = await fetch(`${API_BASE}/token?country=${COUNTRY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Client": "Hygglo-web",
      Origin: "https://www.hygglo.com",
    },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Auth failed for ${accountSlug}: ${tokenRes.status} ${body}`);
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };
  console.log(`[poll-hygglo] Authenticated as ${accountSlug}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access_token}`,
    Accept: "application/json",
    Country: COUNTRY,
    "User-Client": "Hygglo-web",
  };

  // 2. Fetch orders (read-only GETs)
  const filters = ["pending", "current", "future", "obsolete"] as const;
  // Phase 18.2 — also carry the per-order latest_activity from the list
  // response so we can skip the detail fetch when nothing changed since
  // the last poll. Field name is unknown across Hygglo's API versions —
  // probe multiple candidates and pick whatever is present.
  const allOrders: Array<{ id: number; sourceFilter: string; latest_activity?: number | string }> = [];

  // One-shot sample log (first run only) to help us confirm the canonical
  // field name in Hygglo's response. After we see what it actually is we
  // can simplify this probe in a follow-up.
  let sampleLogged = false;

  for (const filter of filters) {
    const res = await fetch(
      `${API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=50`,
      { headers }
    );
    if (!res.ok) continue;
    const data = (await res.json()) as unknown;
    const arr: Array<Record<string, unknown> & { id: number }> = Array.isArray(data)
      ? (data as Array<Record<string, unknown> & { id: number }>)
      : (((data as { items?: Array<Record<string, unknown> & { id: number }> }).items) ?? []);
    if (!sampleLogged && arr.length > 0) {
      console.log(
        `[poll-hygglo] ${accountSlug} list-sample keys: ${Object.keys(arr[0]).join(",")}`
      );
      sampleLogged = true;
    }
    for (const o of arr) {
      // Probe a handful of likely names. First non-undefined wins.
      const la =
        (o.latest_activity as number | string | undefined) ??
        (o.latestActivity as number | string | undefined) ??
        (o.last_activity_at as number | string | undefined) ??
        (o.lastActivityAt as number | string | undefined) ??
        (o.updated_at as number | string | undefined) ??
        (o.updatedAt as number | string | undefined);
      allOrders.push({ id: o.id, sourceFilter: filter, latest_activity: la });
    }
  }

  // Deduplicate by order id — first-seen filter wins (active/current beats obsolete)
  const seen = new Set<number>();
  const uniqueOrders = allOrders.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  console.log(`[poll-hygglo] ${accountSlug}: ${uniqueOrders.length} orders`);

  // Phase 18.2 — pre-fetch stored latest_activity for every order so we can
  // skip per-order detail fetches that haven't changed. Only runs when the
  // list response actually populated the field (else we proceed normally).
  const storedActivity: Record<string, number | string> = lookupStoredLatestActivity
    ? await lookupStoredLatestActivity(uniqueOrders.map((o) => String(o.id)))
    : {};
  let skippedFetch = 0;

  // 3. Fetch each order detail and extract chat messages
  const messages: Array<{
    thread_id: string;
    message_id: string;
    sender: string;
    sender_name?: string;
    body_text: string;
    hygglo_sent_at?: number;
    fetched_at: number;
  }> = [];
  const reservationPayloads: OrderReservationPayload[] = [];

  // Phase 6.1: renter + conversation accumulators
  const renterMap = new Map<string, { hygglo_user_id?: string; display_name: string }>();
  const conversationSpecs: Array<{
    thread_id: string;
    hygglo_user_id?: string;
    display_name: string;
    last_msg_at: number;
    created_at: number;
  }> = [];

  const fetchedAt = Date.now();

  for (const order of uniqueOrders) {
    // Phase 18.2 — skip detail fetch if Hygglo's list response shows the
    // order hasn't changed since our last poll. Only kicks in when the list
    // response actually carries a latest_activity value AND it matches what
    // we previously stored.
    if (order.latest_activity !== undefined) {
      const stored = storedActivity[String(order.id)];
      if (stored !== undefined && stored === order.latest_activity) {
        skippedFetch++;
        continue;
      }
    }
    const detailRes = await fetch(
      `${API_BASE}/v4/my/orders/${order.id}?timezone=Europe/London`,
      { headers }
    );
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as OrderDetail;

    const otherPartName =
      detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? "Renter";
    const otherPartUserId = detail.users?.otherPart?.id
      ? String(detail.users.otherPart.id)
      : undefined;

    // Accumulate renter (dedup by user ID if available, else by name)
    const renterKey = otherPartUserId ?? otherPartName.trim().toLowerCase();
    if (!renterMap.has(renterKey)) {
      renterMap.set(renterKey, {
        hygglo_user_id: otherPartUserId,
        display_name: otherPartName,
      });
    }

    // Extract chat messages and compute conversation timestamps
    const orderMessages: typeof messages = [];
    for (const activity of detail.activities ?? []) {
      if (!activity.chatMessage) continue;
      const text = activity.chatMessage.text?.content ?? "";
      if (!text.trim()) continue;

      const ts = parseCreatedAtLabel(activity.createdAtLabel ?? "")?.getTime();
      orderMessages.push({
        thread_id: String(order.id),
        message_id: activity.key,
        sender: activity.chatMessage.byMe ? "owner" : "renter",
        sender_name: activity.chatMessage.byMe ? "Owner" : otherPartName,
        body_text: text,
        hygglo_sent_at: ts,
        fetched_at: fetchedAt,
      });
    }

    messages.push(...orderMessages);

    // Build conversation spec for orders that have messages
    if (orderMessages.length > 0) {
      const timestamps = orderMessages
        .map((m) => m.hygglo_sent_at ?? fetchedAt)
        .filter((t) => t > 0);
      const lastMsgAt = timestamps.length > 0 ? Math.max(...timestamps) : fetchedAt;
      const firstMsgAt = timestamps.length > 0 ? Math.min(...timestamps) : fetchedAt;
      conversationSpecs.push({
        thread_id: String(order.id),
        hygglo_user_id: otherPartUserId,
        display_name: otherPartName,
        last_msg_at: lastMsgAt,
        created_at: firstMsgAt,
      });
    }

    // Extract reservation metadata from the order detail
    const startUTC = detail.rentalPeriod?.startDateUTC;
    const endUTC = detail.rentalPeriod?.endDateUTC;
    if (startUTC && endUTC) {
      const startDate = startUTC.slice(0, 10);
      const endDate = endUTC.slice(0, 10);
      const grossPaid =
        detail.price?.breakdown?.totalPrice?.amount ??
        detail.price?.total;
      const netToOwner =
        detail.price?.breakdown?.lenderEarnings?.amount ??
        detail.price?.ownerEarnings;
      const currency = detail.price?.currency ?? "GBP";
      const orderItems = (detail.items ?? [])
        .filter((i) => i.type !== "INSURANCE")
        .map((i: any) => ({
          item_name: i.name ?? "Unknown item",
          qty: typeof i.qty === "number" ? i.qty : undefined,
          image: i?.image
            ? {
                url: i.image.url,
                originalUrl: i.image.originalUrl,
                largeUrl: i.image.largeUrl,
                mediumUrl: i.image.mediumUrl,
                thumbnailUrl: i.image.thumbnailUrl,
                // PASS-10: Hygglo's /v4/my/orders/{id}.items[].image actually returns
                // `fullSizeUrl` + `thumbnailUrl` only. Forward fullSizeUrl so the
                // poller can populate hygglo_items[].image_url.
                fullSizeUrl: i.image.fullSizeUrl,
              }
            : undefined,
          type: typeof i.type === "string" ? i.type : undefined,
          product_id: typeof i.productId === "number" ? i.productId : undefined,
          slug: typeof i.slug === "string" ? i.slug : undefined,
        }));
      const start = new Date(startUTC);
      const end = new Date(endUTC);
      const durationDays = Math.round((end.getTime() - start.getTime()) / 86400000);
      // Map sourceFilter to booking status:
      //   "obsolete"  → "cancelled"
      //   "pending"   → "pending_review" (owner hasn't accepted yet)
      //   everything else (current/future) → "confirmed"
      const status =
        order.sourceFilter === "obsolete"
          ? "cancelled"
          : order.sourceFilter === "pending"
            ? "pending_review"
            : "confirmed";
      // Also capture the raw Hygglo booking status from the detail object if present.
      const bookingStatus: string | undefined =
        (detail as any)?.booking?.status ?? undefined;
      // Calendar UI fields — extracted from detail.booking.* and detail.*
      const pickup_time: string | undefined = (detail as any)?.booking?.pickup_time ?? undefined;
      const return_time: string | undefined = (detail as any)?.booking?.return_time ?? undefined;
      const pickup_method: string | undefined = (detail as any)?.booking?.pickup_method ?? undefined;
      const return_method: string | undefined = (detail as any)?.booking?.return_method ?? undefined;
      const notes: string | undefined = (detail as any)?.notes ?? (detail as any)?.detail?.notes ?? undefined;
      const photos_urls: string[] | undefined = (() => {
        const urls: string[] = [];
        if (Array.isArray((detail as any)?.photos_urls)) return (detail as any).photos_urls as string[];
        if (Array.isArray((detail as any)?.detail?.photos_urls)) return (detail as any).detail.photos_urls as string[];
        // Fallback: extract from items[].image.fullSizeUrl (same as v1)
        for (const item of detail.items ?? []) {
          if ((item as any)?.image?.fullSizeUrl) urls.push((item as any).image.fullSizeUrl);
        }
        return urls.length > 0 ? urls : undefined;
      })();
      reservationPayloads.push({
        hygglo_order_id: String(order.id),
        status,
        start_date: startDate,
        end_date: endDate,
        gross_paid_gbp: grossPaid,
        net_to_owner_gbp: netToOwner,
        currency,
        items: orderItems,
        duration_days: durationDays > 0 ? durationDays : undefined,
        sourceFilter: order.sourceFilter,
        renter_name: otherPartName || undefined,
        booking_status: bookingStatus,
        pickup_time,
        return_time,
        pickup_method,
        return_method,
        notes,
        photos_urls,
        latest_activity: order.latest_activity,
        order: detail,
      });
    }
  }

  console.log(
    "[poll-hygglo] " + accountSlug + ": " + String(messages.length) + " messages, " +
    String(reservationPayloads.length) + " reservation payloads, " +
    String(renterMap.size) + " renters, " +
    String(conversationSpecs.length) + " conversations extracted, " +
    String(skippedFetch) + " details skipped (unchanged latest_activity)"
  );

  return {
    messages,
    reservations: reservationPayloads,
    renters: Array.from(renterMap.values()),
    conversations: conversationSpecs,
  };
}

// ── Task ──────────────────────────────────────────────────────

export const pollHyggloInbox = schedules.task({
  id: "poll-hygglo-inbox",
  cron: "*/5 * * * *",
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "poll-hygglo-inbox" });
      return { skipped: true, reason: "uk_quiet_hours" };
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
    const clientSecret = hyggloSecrets["HYGGLO_CLIENT_SECRET"] ?? "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";

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
    ];

    const convex = new ConvexHttpClient(CONVEX_URL);

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
          // Phase 18.2 — callback the scraper uses to ask Convex for the
          // stored latest_activity per order before deciding whether to
          // skip the detail fetch.
          const lookupStored = async (ids: string[]) => {
            if (ids.length === 0) return {};
            try {
              return (await convex.query(api.hygglo.getLatestActivityBatch, {
                hygglo_order_ids: ids,
              })) as Record<string, number | string>;
            } catch (qErr) {
              console.warn(
                `[poll-hygglo] getLatestActivityBatch failed for ${account.slug} (non-fatal):`,
                qErr,
              );
              return {};
            }
          };
          const { messages, reservations, renters, conversations } = await scrapeAccount(
            account.slug, account.email, account.password, clientSecret, lookupStored
          );

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

          // Upsert reservations (batched 50)
          let resInserted = 0;
          let resUpdated = 0;
          // Phase 18.2 — collect freshly-inserted reservation IDs so we can
          // trigger the resolver on-demand instead of waiting up to 60 min.
          const newlyInsertedIds: string[] = [];
          for (let i = 0; i < reservations.length; i += 50) {
            const batch = reservations.slice(i, i + 50);
            for (const payload of batch) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { sourceFilter: _sf, order: _order, ...mutationPayload } = payload;
              const resResult = await convex.mutation(api.hygglo.upsertOrderAsReservation, {
                account_slug: account.slug,
                ...mutationPayload,
                order: payload.order,
                sourceFilter: payload.sourceFilter,
              });
              if (resResult.action === "inserted") {
                resInserted++;
                if (resResult.reservation_id) newlyInsertedIds.push(resResult.reservation_id);
              } else if (resResult.action === "updated") resUpdated++;
            }
          }
          totalReservationsUpserted += resInserted + resUpdated;

          // Phase 18.2 — on-demand resolver trigger for new listings.
          // Bypasses the hourly cron entirely so renters see resolved items
          // within seconds of the order landing in Hygglo.
          if (newlyInsertedIds.length > 0) {
            try {
              await tasks.trigger("resolve-items", { ids: newlyInsertedIds });
              logger.info("[poll-hygglo] triggered resolve-items on-demand", {
                account: account.slug,
                count: newlyInsertedIds.length,
              });
            } catch (trigErr) {
              logger.warn("[poll-hygglo] resolve-items trigger failed (non-fatal)", {
                err: String(trigErr),
                count: newlyInsertedIds.length,
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
            const reconReservations = reconReservationsRaw
              .filter((r) => r.account_slug != null)
              .map((r) => ({
                ...r,
                _id: r._id as string,
                account_slug: r.account_slug as string,
                start_date: r.start_date ?? null,
                end_date: r.end_date ?? null,
              }));

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
