"use node";
/**
 * Notification dispatcher (2026-06-23) — "use node" because web-push needs
 * Node crypto for VAPID signing.
 *
 * Drains undelivered `notification_events` and delivers each via TWO channels:
 *   1. Web Push — to every opted-in browser/PWA subscription (the dashboard
 *      bell). Dead endpoints (404/410) are pruned.
 *   2. Telegram — to Daniel (TELEGRAM_CHAT_ID_DANIEL) with an "Open chat →"
 *      deep-link button. Always-on fallback so notifications work even before
 *      the PWA is installed (iOS web push needs the home-screen PWA).
 *
 * Both carry the same deep link (`/?thread=<id>&account=<slug>`) so a tap lands
 * on the rental-manager chat thread, ready to reply.
 */
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const BASE_URL =
  process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";

function configureVapid(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:daniel.mabro@gmail.com";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

async function sendTelegramWithButton(
  text: string,
  buttonUrl: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID_DANIEL;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: "Open chat →", url: buttonUrl }]],
        },
      }),
    });
  } catch {
    /* non-fatal: web push still delivered */
  }
}

export const dispatchPending = internalAction({
  args: {},
  handler: async (ctx): Promise<{ delivered: number; pushed: number; pruned: number }> => {
    const events = await ctx.runQuery(internal.notifications.getUndelivered, {});
    if (events.length === 0) return { delivered: 0, pushed: 0, pruned: 0 };

    const subs = await ctx.runQuery(internal.notifications.getSubscriptions, {});
    const vapidOk = configureVapid();
    const deadEndpoints = new Set<string>();
    let pushed = 0;

    for (const e of events) {
      const absUrl = `${BASE_URL}${e.url}`;
      // 1) Web push to all subscriptions.
      if (vapidOk) {
        const payload = JSON.stringify({
          title: e.title,
          body: e.body,
          url: e.url, // relative — SW resolves against the PWA origin
          tag: `${e.type}:${e.thread_id}`,
        });
        await Promise.all(
          subs.map(async (s) => {
            try {
              await webpush.sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                payload,
              );
              pushed++;
            } catch (err) {
              const code = (err as { statusCode?: number })?.statusCode;
              if (code === 404 || code === 410) deadEndpoints.add(s.endpoint);
            }
          }),
        );
      }
      // 2) Telegram — OFF by default now that web push works on the phone
      //    (Daniel, 2026-06-24). Re-enable with Convex env NOTIF_TELEGRAM=1.
      if (process.env.NOTIF_TELEGRAM === "1") {
        await sendTelegramWithButton(`${e.title}\n${e.body}`, absUrl);
      }
    }

    await ctx.runMutation(internal.notifications.markDelivered, {
      ids: events.map((e) => e._id),
    });
    if (deadEndpoints.size > 0) {
      await ctx.runMutation(internal.notifications.pruneSubscriptions, {
        endpoints: [...deadEndpoints],
      });
    }
    return { delivered: events.length, pushed, pruned: deadEndpoints.size };
  },
});
