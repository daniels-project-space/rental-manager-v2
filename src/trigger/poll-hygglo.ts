/**
 * poll-hygglo-inbox — Phase 6.0
 *
 * Runs every 5 minutes. Pulls Hygglo credentials from the project-hub vault,
 * authenticates to the Hygglo REST API (read-only) for each account,
 * extracts chat messages from active orders, and upserts into Convex.
 *
 * READ-ONLY on Hygglo: only GET requests after auth. No mutations sent to Hygglo.
 */
import { schedules } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL = "https://hearty-oyster-600.convex.cloud";

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
  users?: { otherPart?: { name?: string } };
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
};

type OrderReservationPayload = {
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: Array<{ item_name: string; qty?: number }>;
  duration_days?: number;
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
  clientSecret: string
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
  const filters = ["pending", "current", "future"] as const;
  const allOrders: Array<{ id: number }> = [];

  for (const filter of filters) {
    const res = await fetch(
      `${API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=50`,
      { headers }
    );
    if (!res.ok) continue;
    const data = (await res.json()) as unknown;
    const arr = Array.isArray(data)
      ? (data as Array<{ id: number }>)
      : ((data as { items?: Array<{ id: number }> }).items ?? []);
    allOrders.push(...arr);
  }

  // Deduplicate by order id
  const seen = new Set<number>();
  const uniqueOrders = allOrders.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  console.log(`[poll-hygglo] ${accountSlug}: ${uniqueOrders.length} orders`);

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

  const fetchedAt = Date.now();

  for (const order of uniqueOrders) {
    const detailRes = await fetch(
      `${API_BASE}/v4/my/orders/${order.id}?timezone=Europe/London`,
      { headers }
    );
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as OrderDetail;

    const otherPartName =
      detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? "Renter";

    for (const activity of detail.activities ?? []) {
      if (!activity.chatMessage) continue;
      const text = activity.chatMessage.text?.content ?? "";
      if (!text.trim()) continue;

      messages.push({
        thread_id: String(order.id),
        message_id: activity.key,
        sender: activity.chatMessage.byMe ? "owner" : "renter",
        sender_name: activity.chatMessage.byMe ? "Owner" : otherPartName,
        body_text: text,
        hygglo_sent_at: parseCreatedAtLabel(activity.createdAtLabel ?? "")?.getTime(),
        fetched_at: fetchedAt,
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
        .map((i) => ({ item_name: i.name ?? "Unknown item" }));
      const start = new Date(startUTC);
      const end = new Date(endUTC);
      const durationDays = Math.round((end.getTime() - start.getTime()) / 86400000);
      reservationPayloads.push({
        hygglo_order_id: String(order.id),
        status: "confirmed",
        start_date: startDate,
        end_date: endDate,
        gross_paid_gbp: grossPaid,
        net_to_owner_gbp: netToOwner,
        currency,
        items: orderItems,
        duration_days: durationDays > 0 ? durationDays : undefined,
      });
    }
  }
  console.log(
    "[poll-hygglo] " + accountSlug + ": " + String(messages.length) + " messages, " +
    String(reservationPayloads.length) + " reservation payloads extracted"
  );
  return { messages, reservations: reservationPayloads };
}

// ── Task ──────────────────────────────────────────────────────

export const pollHyggloInbox = schedules.task({
  id: "poll-hygglo-inbox",
  cron: "*/5 * * * *",
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
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
      error?: string;
    }> = [];

    for (const account of accounts) {
      if (!account.email || !account.password) {
        console.warn(`[poll-hygglo] Missing creds for ${account.slug}, skipping`);
        results.push({ slug: account.slug, ok: false, error: "missing_creds" });
        continue;
      }

      try {
        const { messages, reservations } = await scrapeAccount(account.slug, account.email, account.password, clientSecret);

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

        // Upsert reservations (batched 50)
        let resInserted = 0;
        let resUpdated = 0;
        for (let i = 0; i < reservations.length; i += 50) {
          const batch = reservations.slice(i, i + 50);
          for (const payload of batch) {
            const resResult = await convex.mutation(api.hygglo.upsertOrderAsReservation, {
              account_slug: account.slug,
              ...payload,
            });
            if (resResult.action === "inserted") resInserted++;
            else if (resResult.action === "updated") resUpdated++;
          }
        }

        console.log(
          "[poll-hygglo] " + account.slug + ": " + String(messages.length) + " msgs, " +
          String(totalInserted) + " inserted, " + String(totalSkipped) + " skipped. " +
          "Reservations: " + String(resInserted) + " inserted, " + String(resUpdated) + " updated"
        );

        results.push({
          slug: account.slug,
          ok: true,
          messages: messages.length,
          inserted: totalInserted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[poll-hygglo] ${account.slug} failed: ${msg}`);
        // Continue — Leo failure must not crash DB Cinema
        results.push({ slug: account.slug, ok: false, error: msg });
      }
    }

    const totalInserted = results.reduce((s, r) => s + (r.inserted ?? 0), 0);
    console.log(`[poll-hygglo] Done. Total new messages inserted: ${totalInserted}`);
    return { results, totalInserted, ts: Date.now() };
  },
});
