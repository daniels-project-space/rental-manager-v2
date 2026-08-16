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
  buildConfirmedBookingNotificationCopy,
  type PushNotificationMode,
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

/**
 * Copy for one event as a given mode should see it.
 *
 * The stored `title`/`body` are the full-amount rendering. When the event
 * carries `copy_data` we re-render from the raw amounts instead, so a device on
 * `my_share` gets half the owner earnings. Events without `copy_data` (rows
 * written before 2026-08-16, plus new_request/renter_message) fall back to the
 * stored strings unchanged.
 */
function renderEventCopy(
  e: {
    title: string;
    body: string;
    account_slug?: string;
    copy_data?: {
      renter_name?: string;
      item_name?: string;
      gross?: number;
      net?: number;
      currency?: string;
    };
  },
  mode: PushNotificationMode | undefined,
): { title: string; body: string } {
  if (!e.copy_data) return { title: e.title, body: e.body };
  return buildConfirmedBookingNotificationCopy({
    renterName: e.copy_data.renter_name,
    itemName: e.copy_data.item_name,
    accountSlug: e.account_slug,
    gross: e.copy_data.gross,
    net: e.copy_data.net,
    currency: e.copy_data.currency,
    mode,
  });
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
    // Claim BEFORE sending. dispatchPending is scheduled from several places
    // (queueNotificationEvents, savePushSubscription, sendTestNotification, and
    // its own retry reschedule), so overlapping runs are normal. Claiming inside
    // one serializable mutation is what stops two of them sending the same
    // event — the previous "query undelivered → send → mark delivered" order
    // left the row visibly undelivered for the whole duration of the sends.
    const events = await ctx.runMutation(internal.notifications.claimPending, {});
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

    try {
      for (const e of events) {
        const absUrl = `${BASE_URL}${e.url}`;
        let eventPushed = 0;
        const eligibleSubs = subs.filter((s) =>
          subscriptionReceivesNotification(s.mode, e.type),
        );
        const pushSuppressed = subs.length - eligibleSubs.length;
        // 1) Web push to subscriptions whose per-device mode accepts this event.
        if (vapidOk) {
          await Promise.all(
            eligibleSubs.map(async (s) => {
              try {
                // Payload is per-subscription: a device on "my_share" sees half
                // the owner earnings, everyone else sees the full amount.
                const copy = renderEventCopy(e, s.mode);
                await webpush.sendNotification(
                  { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                  JSON.stringify({
                    title: copy.title,
                    body: copy.body,
                    url: e.url, // relative — SW resolves against the PWA origin
                    tag: `${e.type}:${e.thread_id}`,
                    icon: accountIcon(e.account_slug), // per-account Aputure (recoloured)
                    badge: "/icons/notif-badge.png",
                  }),
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
          const tgCopy = renderEventCopy(
            e,
            telegramNotificationMode(process.env.NOTIF_TELEGRAM_MODE),
          );
          telegramOk = await sendTelegramWithButton(
            `${tgCopy.title}\n${tgCopy.body}`,
            absUrl,
          );
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
    } catch (err) {
      // Unexpected throw mid-batch. Events already in `outcomes` were really
      // attempted, so record them normally (that also clears their claim).
      // The rest were claimed but never touched — hand them straight back so a
      // later dispatcher retries them instead of waiting out the stale window.
      const attempted = new Set<string>(outcomes.map((o) => String(o.id)));
      const untouched = events.filter((e) => !attempted.has(String(e._id)));
      if (outcomes.length > 0) {
        await ctx.runMutation(internal.notifications.markDelivered, {
          ids: outcomes.map((o) => o.id),
          outcomes,
        });
      }
      if (untouched.length > 0) {
        await ctx.runMutation(internal.notifications.releaseClaims, {
          ids: untouched.map((e) => e._id),
        });
      }
      throw err;
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
