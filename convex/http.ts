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

const http = httpRouter();

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
