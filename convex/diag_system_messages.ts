import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Hygglo PLATFORM notices sitting in the renter message stream.
 *
 * Found while sampling real inbound text: "A message was hidden. We hid a
 * message from Stephen S that contained contact details. Hygglo shares contact
 * details ...". That is Hygglo talking, not the renter — but it is stored with
 * sender "renter", so it becomes the last renter message and the bot answers
 * it as though a person said it.
 *
 * Two ways that goes wrong: the bot replies to the platform instead of the
 * customer, and — worse — it may treat the notice's own text as the renter's
 * request, which is untrusted content steering the reply.
 *
 * Counts how many exist and how often one is the LAST renter message in a
 * thread, since that is the case the draft pipeline actually acts on.
 */
const SYSTEM_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "hidden-contact-details", re: /\bA message was hidden\b|\bWe hid a message\b/i },
  { label: "hygglo-policy-notice", re: /\bHygglo (shares|never|will|does not)\b/i },
  { label: "booking-system-notice", re: /\b(booking (request )?(was |has been )?(cancelled|expired|accepted|declined))\b/i },
  { label: "payment-notice", re: /\b(payment (was |has been )?(received|failed|refunded))\b/i },
  { label: "review-prompt", re: /\b(leave a review|review your renter|rate your)\b/i },
];

export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(8000);
    const renterMsgs = msgs.filter(
      (m) => m.sender === "renter" && !m.thread_id.startsWith("__probe__"),
    );

    const counts: Record<string, number> = {};
    const flagged = new Set<string>();
    const samples: Record<string, string> = {};
    for (const m of renterMsgs) {
      const body = m.body_text ?? "";
      for (const p of SYSTEM_PATTERNS) {
        if (!p.re.test(body)) continue;
        counts[p.label] = (counts[p.label] ?? 0) + 1;
        flagged.add(`${m.thread_id}|${m.message_id}`);
        samples[p.label] ??= body.replace(/\s+/g, " ").slice(0, 130);
      }
    }

    // The case that matters: a system notice is the MOST RECENT renter message,
    // so it is what the draft pipeline treats as "what they just asked".
    const latestByThread = new Map<string, (typeof renterMsgs)[number]>();
    for (const m of renterMsgs) {
      const cur = latestByThread.get(m.thread_id);
      if (!cur || (m.hygglo_sent_at ?? 0) > (cur.hygglo_sent_at ?? 0))
        latestByThread.set(m.thread_id, m);
    }
    const lastIsSystem = [...latestByThread.values()].filter((m) =>
      SYSTEM_PATTERNS.some((p) => p.re.test(m.body_text ?? "")),
    );

    return {
      renter_messages_scanned: renterMsgs.length,
      system_messages_stored_as_renter: flagged.size,
      by_pattern: counts,
      samples,
      threads_scanned: latestByThread.size,
      threads_where_last_renter_msg_is_a_system_notice: lastIsSystem.length,
      last_is_system_samples: lastIsSystem.slice(0, 4).map((m) => ({
        thread: m.thread_id,
        text: (m.body_text ?? "").replace(/\s+/g, " ").slice(0, 110),
      })),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_system_messages.check, {}),
});
