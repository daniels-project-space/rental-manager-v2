/**
 * DB Cinema WEB profile sync (2026-06-25).
 *
 * Pulls the db-cinema-v2 storefront's OWN paid bookings up into RMv2 as
 * reservations under account_slug="dbcinema_web", so the website's rentals show
 * up exactly like the Hygglo accounts: ongoing/upcoming rentals, the calendar,
 * per-item availability, and revenue. Mirror-image of the sync that already
 * pushes Hygglo availability DOWN into the storefront.
 *
 *   syncDbcinemaWeb (internalAction) — fetches the storefront's bookings feed
 *     (rmv2_sync:forRmv2Sync, token-guarded) over Convex's HTTP query API and
 *     hands them to the upsert mutation.
 *   upsertSiteBookingsBatch (internalMutation) — maps each booking's decomposed
 *     Hygglo product IDs to RMv2 items (via the dbcinema hygglo_product_index),
 *     writing expanded_items/resolved_items so availability + conflict detection
 *     count the website rentals against the SAME physical stock as Hygglo.
 *
 * Revenue: the storefront is direct (no Hygglo ~36% fee), so net_to_owner_gbp =
 * subtotal − discount (the rental income; refundable deposit + delivery
 * pass-through excluded), platform_fee_pct = 0.
 *
 * Cron: every 30 min (convex/crons.ts). Env required on Convex prod:
 *   DBCINEMA_CONVEX_URL   (e.g. https://veracious-wombat-196.convex.cloud)
 *   DBCINEMA_ADMIN_TOKEN  (the storefront's ADMIN_TOKEN)
 */
import { internalAction, internalMutation } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Self-reference by name: this module is new and not yet in the committed
// _generated/api type map, so the typed `internal.sync_dbcinema_web.*` would
// break `next build`'s typecheck. By-name avoids that (same pattern as the
// dashboard chat tools).
const upsertBatchRef = makeFunctionReference<"mutation">(
  "sync_dbcinema_web:upsertSiteBookingsBatch",
);
// Force-rebuild the Active-Rentals MV after a change, exactly like the Hygglo
// poller does (its dirty-probe only scans recent future-dated rows, so a web
// status change would otherwise not surface on the tiles until the hourly cron).
const statsDrawerRefreshRef = makeFunctionReference<"mutation">(
  "mv/stats_drawer:refresh",
);

const WEB_SLUG = "dbcinema_web";
// The storefront's gear is DB Cinema's gear; its product IDs live in the
// hygglo_product_index under the "dbcinema" Hygglo account.
const STOCK_ACCOUNT = "dbcinema";

type SiteUnit = { hyggloProductId: number; qty: number };
type SiteLine = { title: string; qty: number; start: number; end: number; units: SiteUnit[] };
type SiteBooking = {
  id: string;
  status: string;
  customerName: string | null;
  customerEmail: string | null;
  fulfilment: string;
  pickupTime: string | null;
  returnTime: string | null;
  start: number;
  end: number;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  depositAmount: number;
  total: number;
  currency: string;
  createdAt: number;
  lineItems: SiteLine[];
};

export const syncDbcinemaWeb = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; reason?: string; upserted?: number; mapped_units?: number; unmapped_units?: number }> => {
    const url = process.env.DBCINEMA_CONVEX_URL;
    const token = process.env.DBCINEMA_ADMIN_TOKEN;
    if (!url || !token) {
      console.error("[dbcinema_web sync] missing DBCINEMA_CONVEX_URL / DBCINEMA_ADMIN_TOKEN");
      return { ok: false, reason: "missing_config" };
    }
    let payload: { authorized?: boolean; bookings?: SiteBooking[] };
    try {
      const resp = await fetch(`${url.replace(/\/$/, "")}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "rmv2_sync:forRmv2Sync",
          args: { token },
          format: "json",
        }),
      });
      const json = (await resp.json()) as { status?: string; value?: unknown; errorMessage?: string };
      if (json.status !== "success") {
        console.error("[dbcinema_web sync] storefront query failed:", json.errorMessage ?? json.status);
        return { ok: false, reason: "query_failed" };
      }
      payload = json.value as { authorized?: boolean; bookings?: SiteBooking[] };
    } catch (err) {
      console.error("[dbcinema_web sync] fetch error:", err instanceof Error ? err.message : err);
      return { ok: false, reason: "fetch_error" };
    }
    if (!payload?.authorized) return { ok: false, reason: "unauthorized" };
    const bookings = Array.isArray(payload.bookings) ? payload.bookings : [];
    const res = await ctx.runMutation(upsertBatchRef, {
      bookings: bookings as unknown[],
    });
    return { ok: true, ...res };
  },
});

export const upsertSiteBookingsBatch = internalMutation({
  args: { bookings: v.array(v.any()) },
  handler: async (ctx, { bookings }) => {
    // Ensure the account row exists so the switcher pill + avatar render.
    const acct = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", WEB_SLUG))
      .first();
    if (!acct) {
      await ctx.db.insert("accounts", {
        slug: WEB_SLUG,
        display_name: "DB Cinema Web",
        notes: "DB Cinema's direct rental website (db-cinema-v2 storefront).",
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // Build product_id → {item_id, canonical name} from the dbcinema index.
    const [idxRows, items] = await Promise.all([
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("items").collect(),
    ]);
    const itemById = new Map(items.map((i) => [String(i._id), i]));
    const pidToItem = new Map<number, { item_id: Id<"items">; name: string; image_url: string | null }>();
    for (const r of idxRows) {
      if (r.account_slug !== STOCK_ACCOUNT) continue;
      const it = itemById.get(String(r.item_id));
      pidToItem.set(r.product_id, {
        item_id: r.item_id,
        name: it?.name_canonical ?? "item",
        image_url: (it as { image_url?: string | null } | undefined)?.image_url ?? null,
      });
    }

    let upserted = 0;
    let mappedUnits = 0;
    let unmappedUnits = 0;
    const incomingIds = new Set(
      (bookings as SiteBooking[]).map((b) => b?.id).filter(Boolean),
    );

    for (const raw of bookings as SiteBooking[]) {
      const b = raw;
      if (!b || !b.id || !b.start || !b.end) continue;
      const startISO = new Date(b.start).toISOString().slice(0, 10);
      const endISO = new Date(b.end).toISOString().slice(0, 10);
      // status → RMv2 status + order_step (so due-returns / Return Hub / the
      // ongoing-vs-upcoming split treat web rentals like Hygglo ones):
      //   confirmed = paid, not yet collected → upcoming (no order_step)
      //   active    = currently out with the customer → DELIVERED
      //   returned  = back → completed (REVIEWED)
      const status = b.status === "returned" ? "completed" : "confirmed";
      const order_step =
        b.status === "active" ? "DELIVERED"
        : b.status === "returned" ? "REVIEWED"
        : undefined;

      // Decompose to physical RMv2 items so availability/conflict count these.
      const byItem = new Map<string, { item_id: Id<"items">; name: string; qty: number; image_url: string | null }>();
      // Per Hygglo-product accumulation, so we can emit hygglo_items — the path
      // the dashboard's image resolver actually reads for per-rental thumbnails.
      const byProduct = new Map<number, { name: string; image_url: string | null; qty: number }>();
      for (const li of b.lineItems ?? []) {
        for (const u of li.units ?? []) {
          const hit = pidToItem.get(u.hyggloProductId);
          if (!hit) {
            unmappedUnits++;
            continue;
          }
          mappedUnits++;
          const cur = byItem.get(String(hit.item_id));
          if (cur) cur.qty += u.qty;
          else byItem.set(String(hit.item_id), { item_id: hit.item_id, name: hit.name, qty: u.qty, image_url: hit.image_url });
          const pcur = byProduct.get(u.hyggloProductId);
          if (pcur) pcur.qty += u.qty;
          else byProduct.set(u.hyggloProductId, { name: hit.name, image_url: hit.image_url, qty: u.qty });
        }
      }
      const hygglo_items = [...byProduct.entries()].map(([product_id, p]) => ({
        product_id,
        name: p.name,
        qty: p.qty,
        image_url: p.image_url,
        type: "item",
      }));
      const expanded_items = [...byItem.values()].map((e) => ({
        item_id: e.item_id,
        item_name_canonical: e.name,
        qty: e.qty,
      }));
      // Reservation photos = the mapped items' canonical images, so the cards +
      // calendar render real thumbnails (web bookings carry no Hygglo photos).
      // photos_urls feeds the simple mappers; image_hints feeds mapRental (which
      // ignores photos_urls and builds per-item tiles from hints keyed by the
      // normalised item name).
      const photos_urls = [
        ...new Set([...byItem.values()].map((e) => e.image_url).filter((u): u is string => !!u)),
      ];
      const image_hints = [...byItem.values()]
        .filter((e) => !!e.image_url)
        .map((e) => ({
          captured_at: Date.now(),
          image_url: e.image_url as string,
          item_name: e.name,
          item_name_normalised: e.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
          source: "manual_override" as const,
        }));
      const resolved_items = expanded_items.map((e) => ({
        item_id: e.item_id,
        item_name_canonical: e.item_name_canonical,
        confidence: 1,
        qty: e.qty,
      }));
      // Display the resolved canonical items (clean names + image matches);
      // fall back to the raw booking titles when nothing mapped.
      const itemsDisplay =
        expanded_items.length > 0
          ? expanded_items.map((e) => ({ item_name: e.item_name_canonical, qty: e.qty }))
          : (b.lineItems ?? []).map((li) => ({ item_name: li.title, qty: li.qty }));

      const method = b.fulfilment === "delivery" ? "delivery" : "collection";
      const net = Math.max(0, (b.subtotal ?? 0) - (b.discount ?? 0));
      const gross = Math.max(0, (b.total ?? 0) - (b.depositAmount ?? 0));
      const durationDays = Math.max(1, Math.round((b.end - b.start) / 86_400_000) + 1);

      const fields: Record<string, unknown> = {
        account_slug: WEB_SLUG,
        hygglo_order_id: b.id, // storefront booking _id — globally unique dedup key
        status,
        start_date: startISO,
        end_date: endISO,
        pickup_date: startISO,
        return_date: endISO,
        pickup_method: method,
        return_method: method,
        renter_name: b.customerName ?? b.customerEmail ?? "Website customer",
        items: itemsDisplay,
        resolved_items,
        expanded_items,
        ...(photos_urls.length > 0 ? { photos_urls } : {}),
        ...(image_hints.length > 0 ? { image_hints } : {}),
        ...(hygglo_items.length > 0 ? { hygglo_items } : {}),
        ...(order_step ? { order_step } : {}),
        gross_paid_gbp: gross,
        net_to_owner_gbp: net,
        platform_fee_gbp: 0,
        platform_fee_pct: 0,
        delivery_fee_gbp: b.deliveryFee ?? 0,
        currency: b.currency ?? "GBP",
        duration_days: durationDays,
        is_obsolete: false,
        source_filter: "dbcinema_web_site",
        booking_status: b.status,
        last_polled_at: Date.now(),
      };
      if (b.pickupTime) fields.pickup_time = b.pickupTime;
      if (b.returnTime) fields.return_time = b.returnTime;

      const existing = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", b.id))
        .collect();
      const mine = existing.find((r) => r.account_slug === WEB_SLUG);
      if (mine) {
        await ctx.db.patch(mine._id, fields);
      } else {
        await ctx.db.insert("reservations", { ...fields, created_at: Date.now() } as never);
      }
      upserted++;
    }

    // Reconcile: a CONFIRMED dbcinema_web reservation that's no longer in the
    // paid feed was cancelled (or removed) upstream — flip it to cancelled so
    // the profile doesn't show a phantom upcoming rental forever. Completed
    // rows (from `returned` bookings) are historical revenue and left as-is.
    let cancelled = 0;
    if (incomingIds.size > 0 || bookings.length === 0) {
      const confirmedRows = await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", "confirmed"))
        .collect();
      for (const r of confirmedRows) {
        if (r.account_slug !== WEB_SLUG) continue;
        const oid = (r as { hygglo_order_id?: string }).hygglo_order_id;
        if (oid && incomingIds.has(oid)) continue;
        await ctx.db.patch(r._id, {
          status: "cancelled",
          is_obsolete: true,
          obsolete_reason: "renter_cancelled",
          last_polled_at: Date.now(),
        });
        cancelled++;
      }
    }

    // Reactively rebuild the Active-Rentals MV so the dashboard tiles reflect
    // the change now (the hourly MV cron's dirty-probe can miss web rows).
    if (upserted > 0 || cancelled > 0) {
      await ctx.scheduler.runAfter(0, statsDrawerRefreshRef, { force: true });
    }

    return { upserted, mapped_units: mappedUnits, unmapped_units: unmappedUnits, cancelled };
  },
});

/**
 * Admin: hard-delete a synced website reservation by its storefront booking id
 * (e.g. to remove a test row). Reconciliation only soft-cancels; this purges.
 */
/**
 * Admin: purge ALL synced website data (reservations + weekly_metrics rows for
 * the web profile). Used to clear test data / reset the profile to empty.
 */
export const adminPurgeWebData = internalMutation({
  args: {},
  handler: async (ctx) => {
    let reservations = 0;
    for (const status of ["confirmed", "completed", "cancelled", "pending_review", "declined"]) {
      const rows = await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const r of rows) {
        if (r.account_slug !== WEB_SLUG) continue;
        await ctx.db.delete(r._id);
        reservations++;
      }
    }
    let weekly_metrics = 0;
    for (const m of await ctx.db.query("weekly_metrics").collect()) {
      if ((m as { account_slug?: string }).account_slug !== WEB_SLUG) continue;
      await ctx.db.delete(m._id);
      weekly_metrics++;
    }
    if (reservations > 0) {
      await ctx.scheduler.runAfter(0, statsDrawerRefreshRef, { force: true });
    }
    return { reservations, weekly_metrics };
  },
});

export const adminDeleteSiteBooking = internalMutation({
  args: { externalId: v.string() },
  handler: async (ctx, { externalId }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", externalId))
      .collect();
    let deleted = 0;
    for (const r of rows) {
      if (r.account_slug !== WEB_SLUG) continue;
      await ctx.db.delete(r._id);
      deleted++;
    }
    return { deleted };
  },
});
