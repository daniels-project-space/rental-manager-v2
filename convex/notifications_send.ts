"use node";
/**
 * Notification dispatcher (2026-06-23) — "use node" because web-push needs
 * Node crypto for VAPID signing.
 *
 * Drains undelivered `notification_events` and delivers each via TWO channels:
 *   1. Web Push — to every opted-in browser/PWA subscription (the dashboard
 *      bell). Dead endpoints (404/410) are pruned.
 *   2. Telegram — to Daniel (TELEGRAM_CHAT_ID_DANIEL) with an "Open chat →"
 *      deep-link button. Defaults to money-only so Daniel receives the Wohooo
 *      earnings alert while Leo's browser/PWA can remain on all updates.
 *
 * Both carry the same deep link (`/?thread=<id>&account=<slug>`) so a tap lands
 * on the rental-manager chat thread, ready to reply.
 */
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  subscriptionReceivesNotification,
  telegramNotificationMode,
} from "./lib/notification_events";
import { automatedTelegramAlertsEnabled } from "./lib/telegram_convex";

const BASE_URL =
  process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";

// Per-account Aputure notification icon (recoloured to the account accent so you
// can tell at a glance which account a notification came from). dbcinema keeps
// the original blue; the default also blue. Relative — the SW resolves against
// the PWA origin. PNGs live in public/icons/.
const NOTIF_ICON: Record<string, string> = {
  dbcinema: "/icons/notif-aputure.png", // blue (original)
  leo: "/icons/notif-aputure-leo.png", // purple
  diogo: "/icons/notif-aputure-diogo.png", // orange
  dbcinema_web: "/icons/notif-aputure-dbcinema_web.png", // emerald
};
function accountIcon(slug?: string | null): string {
  return (slug && NOTIF_ICON[slug]) || "/icons/notif-aputure.png";
}

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
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID_DANIEL;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    if (!res.ok) {
      console.warn("[notifications] telegram send failed", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[notifications] telegram send threw", String(err));
    return false;
  }
}

export const dispatchPending = internalAction({
  args: {},
  handler: async (ctx): Promise<{ delivered: number; pushed: number; pruned: number }> => {
    const events = await ctx.runQuery(internal.notifications.getUndelivered, {});
    if (events.length === 0) return { delivered: 0, pushed: 0, pruned: 0 };

    const subs = await ctx.runQuery(internal.notifications.getSubscriptions, {});
    const vapidOk = configureVapid();
    if (!vapidOk) console.warn("[notifications] VAPID keys missing — web push disabled");
    const deadEndpoints = new Set<string>();
    let pushed = 0;
    const outcomes: Array<{
      id: (typeof events)[number]["_id"];
      push_ok: number;
      push_eligible: number;
      push_suppressed: number;
      telegram_ok: boolean;
      telegram_eligible: boolean;
      telegram_suppressed: boolean;
    }> = [];

    for (const e of events) {
      const absUrl = `${BASE_URL}${e.url}`;
      let eventPushed = 0;
      const eligibleSubs = subs.filter((s) =>
        subscriptionReceivesNotification(s.mode, e.type),
      );
      const pushSuppressed = subs.length - eligibleSubs.length;
      // 1) Web push to subscriptions whose per-device mode accepts this event.
      if (vapidOk) {
        const payload = JSON.stringify({
          title: e.title,
          body: e.body,
          url: e.url, // relative — SW resolves against the PWA origin
          tag: `${e.type}:${e.thread_id}`,
          icon: accountIcon(e.account_slug), // per-account Aputure (recoloured)
          badge: "/icons/notif-badge.png",
        });
        await Promise.all(
          eligibleSubs.map(async (s) => {
            try {
              await webpush.sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                payload,
              );
              pushed++;
              eventPushed++;
            } catch (err) {
              const code = (err as { statusCode?: number })?.statusCode;
              if (code === 404 || code === 410) deadEndpoints.add(s.endpoint);
              // Every failure is LOGGED: silent non-404 failures (403 expired
              // Apple tokens, 400 VAPID mismatch…) are how the "wohoo" died
              // without anyone noticing — delivered_at was set regardless.
              console.warn(
                "[notifications] web push failed",
                code ?? String(err).slice(0, 120),
                s.endpoint.slice(0, 60),
              );
            }
          }),
        );
      }
      // 2) System-generated Telegram is opt-in. This preserves browser/PWA
      //    notifications but stops unsolicited messages by default.
      let telegramOk = false;
      const telegramEnabled = automatedTelegramAlertsEnabled();
      const telegramEligible = telegramEnabled && subscriptionReceivesNotification(
        telegramNotificationMode(process.env.NOTIF_TELEGRAM_MODE),
        e.type,
      );
      const telegramSuppressed = telegramEnabled && !telegramEligible;
      if (telegramEligible) {
        telegramOk = await sendTelegramWithButton(`${e.title}\n${e.body}`, absUrl);
      }
      const eligibleChannels = eligibleSubs.length + (telegramEligible ? 1 : 0);
      const suppressedChannels = pushSuppressed + (telegramSuppressed ? 1 : 0);
      const intentionallySuppressed = eligibleChannels === 0 && suppressedChannels > 0;
      if (eventPushed === 0 && !telegramOk && !intentionallySuppressed) {
        console.warn(`[notifications] event ${String(e._id)} (${e.type}) reached NO channel — check subscriptions/Telegram env`);
      }
      outcomes.push({
        id: e._id,
        push_ok: eventPushed,
        push_eligible: eligibleSubs.length,
        push_suppressed: pushSuppressed,
        telegram_ok: telegramOk,
        telegram_eligible: telegramEligible,
        telegram_suppressed: telegramSuppressed,
      });
    }

    const delivery = await ctx.runMutation(internal.notifications.markDelivered, {
      ids: events.map((e) => e._id),
      outcomes,
    });
    if (delivery.retryable > 0 && delivery.retryAfterMs !== undefined) {
      await ctx.scheduler.runAfter(
        delivery.retryAfterMs,
        internal.notifications_send.dispatchPending,
        {},
      );
    }
    if (deadEndpoints.size > 0) {
      await ctx.runMutation(internal.notifications.pruneSubscriptions, {
        endpoints: [...deadEndpoints],
      });
    }
    return { delivered: delivery.delivered, pushed, pruned: deadEndpoints.size };
  },
});
