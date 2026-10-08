/**
 * Convex HTTP router — public webhook endpoints.
 *
 * Wave 4: inbound Telegram webhook for /vacation commands.
 *
 * Endpoint: POST /telegram/webhook?secret=<TELEGRAM_WEBHOOK_SECRET>
 *
 * Validation steps:
 *   1. ?secret= query param must match env TELEGRAM_WEBHOOK_SECRET → else 401
 *   2. JSON body must parse → else 400
 *   3. message.chat.id must equal env TELEGRAM_ADMIN_CHAT_ID → else 403 silent
 *   4. Dispatches to internal action telegram_inbound.handleTelegramUpdate
 *
 * Always returns 200 to Telegram after auth passes (Telegram retries on non-2xx).
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();
authComponent.registerRoutes(http, createAuth);

/**
 * Ported Listings — VPS callback sink (Phase 4, Wave 2, ADDITIVE).
 *
 * POST /port-listings/record
 *
 * The VPS "hygglo" port service runs the full-resolution 262-image batch
 * itself (Vercel would time out) and POSTs one of these per image as it
 * finishes, so each row's status lands in `ported_listings` incrementally.
 *
 * Auth: header `X-Port-Token` must equal env HYGGLO_PORT_RECORD_TOKEN.
 *   - missing env  → 503 (fail closed)
 *   - bad/absent header → 401
 * Body: { productId, status, portedR2Key?, portedUrl?, error? } → ported_listings:upsert
 */
http.route({
  path: "/port-listings/record",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.HYGGLO_PORT_RECORD_TOKEN ?? "";
    if (!expected) {
      return new Response(
        JSON.stringify({ ok: false, error: "server_missing_HYGGLO_PORT_RECORD_TOKEN" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const provided = request.headers.get("x-port-token") ?? "";
    if (!provided || provided !== expected) {
      return new Response(
        JSON.stringify({ ok: false, error: "unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "bad json" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const productId = body?.productId;
    const status = body?.status;
    if (typeof productId !== "string" && typeof productId !== "number") {
      return new Response(
        JSON.stringify({ ok: false, error: "productId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const allowed = ["pending", "ported", "error"] as const;
    if (typeof status !== "string" || !allowed.includes(status as any)) {
      return new Response(
        JSON.stringify({ ok: false, error: "status must be pending|ported|error" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      await ctx.runMutation(internal.ported_listings.__service_upsert, {
        productId: String(productId),
        status: status as (typeof allowed)[number],
        ...(typeof body.portedR2Key === "string" ? { portedR2Key: body.portedR2Key } : {}),
        ...(typeof body.portedUrl === "string" ? { portedUrl: body.portedUrl } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ ok: false, error: msg }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/** Private, read-only storefront transport. Its fixed allowlist cannot invoke
 * arbitrary queries, change accounts or write manager data. */
export const storefrontRead = httpAction(async (ctx, request) => {
  const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  const expected = process.env.DBCINEMA_WEBHOOK_SECRET;
  if (!expected) return reply(503, { status: "error", error: "service_not_configured" });
  if (request.headers.get("x-dbcinema-sync-token") !== expected)
    return reply(401, { status: "error", error: "unauthorized" });
  let input: any;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 4096) return reply(413, { status: "error", error: "request_too_large" });
    input = JSON.parse(text);
  } catch { return reply(400, { status: "error", error: "invalid_request" }); }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !["path", "args"].includes(k)) ||
      !input.args || typeof input.args !== "object" || Array.isArray(input.args))
    return reply(400, { status: "error", error: "invalid_request" });
  const path = input.path;
  const args = input.args;
  const exactArgs = (key?: string) => key
    ? Object.keys(args).length === 1 && args[key] === "dbcinema"
    : Object.keys(args).length === 0;
  const calls = {
    "items:sharedStockForStorefront": { ref: internal.items.__service_sharedStockForStorefront, key: undefined },
    "hygglo_products:catalogueForStorefront": { ref: internal.hygglo_products.__service_catalogueForStorefront, key: "accountSlug" },
    "hygglo_products:list": { ref: internal.hygglo_products.__service_listForStorefront, key: "accountSlug" },
    "items:listForReconcile": { ref: internal.items.__service_listForStorefront, key: undefined },
    "reservations:listActiveForStorefront": { ref: internal.reservations.__service_listActiveForStorefront, key: "account_slug" },
    "reservations:listForReconcile": { ref: internal.reservations.__service_listDemandForStorefront, key: "account_slug" },
  } as const;
  if (typeof path !== "string" || !Object.prototype.hasOwnProperty.call(calls, path))
    return reply(400, { status: "error", error: "unsupported_read" });
  const selected = calls[path as keyof typeof calls];
  if (!exactArgs(selected.key)) return reply(400, { status: "error", error: "invalid_account_or_arguments" });
  try {
    const rows = await ctx.runQuery(selected.ref, args);
    const pick = (row: any, fields: string[]) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
    const value = rows.map((row: any) => {
      if(path==="items:sharedStockForStorefront") return {version:row.version,checkedAt:row.checkedAt,units:row.units.map((unit:any)=>({masterItemId:unit.masterItemId,active:unit.active,quantityOwned:unit.quantityOwned,windows:unit.windows.map((window:any)=>pick(window,["start","end","qty"]))}))};
      if (path === "hygglo_products:list" || path === "hygglo_products:catalogueForStorefront") return pick(row, ["productId", "name", "isPublished", "isMarketingOnly", "valuation", "minimumRentalDays", "prices", "images", "unavailableDates", "listings", "masterItemId", ...(path === "hygglo_products:catalogueForStorefront" ? ["stockMapping"] : [])]);
      if (path === "items:listForReconcile") return pick(row, ["_id", "name", "display_name", "aliases", "qty", "status", "is_marketing_only"]);
      return {
        ...pick(row, ["_id", "hygglo_order_id", "start_date", "end_date", "pickup_date", "return_date", "order_step", "status", "is_obsolete"]),
        items: (row.items ?? []).map((item: any) => pick(item, ["product_id", "item_name", "qty"])),
        resolved_items: (row.resolved_items ?? []).map((item: any) => pick(item, ["item_id", "item_name_canonical", "qty"])),
        ...(Array.isArray(row.physical_items) ? {physical_items:row.physical_items.map((item:any) => pick(item,["item_id","qty"]))} : {}),
      };
    });
    return reply(200, { protocolVersion: 1, status: "success", path, value });
  } catch { return reply(503, { status: "error", error: "source_read_failed" }); }
});
http.route({ path: "/dbcinema/storefront-read", method: "POST", handler: storefrontRead });

/**
 * DB Cinema storefront → RMv2 booking push (2026-08-18).
 *
 * POST /dbcinema/booking-sync
 *
 * Event-driven replacement for the 30-min `syncDbcinemaWeb` poll: db-cinema-v2
 * calls this the moment a booking is confirmed / returned / cancelled /
 * rescheduled / extended / has an add-on attached, so RMv2 reflects the change
 * in seconds instead of up to half an hour. The poll survives as an 8-hourly
 * reliability fallback, so a dropped push is self-healing.
 *
 * Auth: header `x-dbcinema-sync-token` must equal env DBCINEMA_WEBHOOK_SECRET.
 *   - missing env → 503 (fail closed)
 *   - bad/absent header → 401
 * Body: { booking } (one SiteBooking) → sync_dbcinema_web:upsertSiteBookingsBatch
 *
 * reconcile:false is REQUIRED here: the batch mutation's default behaviour
 * cancels any confirmed web reservation absent from the incoming feed, and a
 * one-booking payload would otherwise wipe out every other live booking.
 */
http.route({
  path: "/dbcinema/booking-sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.DBCINEMA_WEBHOOK_SECRET ?? "";
    if (!expected) {
      return new Response(
        JSON.stringify({ ok: false, error: "server_missing_DBCINEMA_WEBHOOK_SECRET" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const provided = request.headers.get("x-dbcinema-sync-token") ?? "";
    if (!provided || provided !== expected) {
      return new Response(
        JSON.stringify({ ok: false, error: "unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "bad json" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const booking = body?.booking;
    if (!booking || typeof booking !== "object" || typeof booking.id !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "booking object with string id required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    let result: unknown;
    try {
      result = await ctx.runMutation(internal.sync_dbcinema_web.upsertSiteBookingsBatch, {
        bookings: [booking],
        reconcile: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ ok: false, error: msg }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/telegram/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Validate shared secret in query param
    const url = new URL(request.url);
    const providedSecret = url.searchParams.get("secret") ?? "";
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return new Response("unauthorized", { status: 401 });
    }

    // 2. Parse JSON body
    let update: any;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // 3. Extract message — Telegram update shape
    const msg = update?.message ?? update?.edited_message;
    const chatId = msg?.chat?.id;
    const text = msg?.text;
    const username: string | undefined = msg?.from?.username;

    if (chatId === undefined || typeof text !== "string") {
      // Non-message update (callback_query, etc.) — accept silently.
      return new Response("ok", { status: 200 });
    }

    // 4. Admin chat check
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
    if (!adminChatId || String(chatId) !== adminChatId) {
      // Silently accept (don't reveal bot existence to non-admins)
      return new Response("ok", { status: 200 });
    }

    // 5. Dispatch (fire-and-await so any errors are caught by Convex)
    try {
      await ctx.runAction(internal.telegram_inbound.handleTelegramUpdate, {
        chat_id: String(chatId),
        text,
        username,
      });
    } catch (e) {
      // Log via response body — Convex captures stderr; Telegram doesn't care.
      console.error("telegram_inbound dispatch failed:", e);
    }

    return new Response("ok", { status: 200 });
  }),
});

export default http;
