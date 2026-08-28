import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * What renters ACTUALLY ask, from real Hygglo messages.
 *
 * Every gap found so far was found by guessing at a question and testing it.
 * This inverts that: cluster the real inbound messages by topic, so effort goes
 * to what people actually ask rather than what seemed plausible to me.
 *
 * Read-only, renter-side messages only, and it returns COUNTS plus short
 * anonymised snippets — not a dump of customer correspondence.
 */
const TOPICS: Array<{ topic: string; re: RegExp }> = [
  { topic: "availability/dates", re: /\b(available|availability|free|still up|book|booked)\b/i },
  { topic: "price/discount", re: /\b(price|cost|how much|cheaper|discount|deal|offer)\b/i },
  { topic: "what's included", re: /\b(include[ds]?|come[s]? with|in the kit|what.s in|box)\b/i },
  { topic: "collection/pickup", re: /\b(collect|pick ?up|pickup|where are you|address|location)\b/i },
  { topic: "delivery", re: /\b(deliver|courier|drop ?off|post|ship)\b/i },
  { topic: "timing/hours", re: /\b(what time|when can|early|late|evening|morning|tonight)\b/i },
  { topic: "compatibility/specs", re: /\b(fit|compatible|mount|work with|spec|resolution|4k|6k|lens|battery|card)\b/i },
  { topic: "extend/change booking", re: /\b(extend|another day|keep it|change|move|reschedule|swap)\b/i },
  { topic: "damage/insurance/deposit", re: /\b(damage[ds]?|insur\w+|deposit|broke|lost|cover)\b/i },
  { topic: "cancel/refund", re: /\b(cancel\w*|refund|money back)\b/i },
  { topic: "id/verification", re: /\b(id\b|verif\w+|passport|licence|license|deposit hold)\b/i },
  { topic: "condition/age", re: /\b(condition|how old|new|used|serviced|working)\b/i },
  { topic: "instructions/how-to", re: /\b(how do i|how to|instructions|manual|set ?up|settings)\b/i },
];

export const check = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(limit ?? 4000);
    const renterMsgs = msgs.filter(
      (m) => m.sender === "renter" && !m.thread_id.startsWith("__probe__"),
    );
    const counts: Record<string, number> = {};
    const samples: Record<string, string[]> = {};
    let uncategorised = 0;
    const uncatSamples: string[] = [];
    for (const m of renterMsgs) {
      const body = (m.body_text ?? "").replace(/\s+/g, " ").trim();
      if (body.length < 8) continue;
      let hit = false;
      for (const t of TOPICS) {
        if (!t.re.test(body)) continue;
        hit = true;
        counts[t.topic] = (counts[t.topic] ?? 0) + 1;
        if ((samples[t.topic] ?? []).length < 2) {
          samples[t.topic] = [...(samples[t.topic] ?? []), body.slice(0, 90)];
        }
      }
      if (!hit) {
        uncategorised++;
        if (uncatSamples.length < 120) uncatSamples.push(body.slice(0, 100));
      }
    }
    return {
      renter_messages_scanned: renterMsgs.length,
      by_topic: Object.fromEntries(
        Object.entries(counts).sort((a, b) => b[1] - a[1]),
      ),
      samples,
      uncategorised,
      // The interesting part: questions that fit none of the topics we've
      // considered are where an unknown gap would hide.
      uncategorised_samples: uncatSamples,
    };
  },
});

export default internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_renter_questions.check, a),
});
