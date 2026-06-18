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
import { internal, api } from "./_generated/api";

const http = httpRouter();

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
      await ctx.runMutation(api.ported_listings.upsert, {
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
