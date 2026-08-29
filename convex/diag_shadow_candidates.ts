import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * How much REAL traffic can be replayed against the bot?
 *
 * Every quality number in this project so far comes from scenarios I wrote,
 * graded by rubrics I wrote. That measures the bot against my idea of a good
 * reply. The only external yardstick available is what Daniel ACTUALLY sent to
 * a real renter: for each point in a real thread where a renter asked something
 * and he answered, his answer is ground truth we did not invent.
 *
 * A replayable point is a renter message with an owner reply immediately after
 * it. The prefix up to that renter message is the input; his reply is the
 * expected output.
 *
 * Sizing this FIRST because the method is only worth building if there are
 * enough pairs to say anything. Counts by account and by whether the thread
 * has resolvable items, since a thread whose items never resolved will make
 * the bot answer "I'll check" for reasons that have nothing to do with the
 * model.
 */

/** Hygglo platform notices are stored with sender "renter" but nobody said them. */
const SYSTEM_NOTICE =
  /\bA message was hidden\b|\bWe hid a message\b|\bHygglo (shares|never|will|does not)\b|\b(leave a review|rate your)\b/i;

export const scan = internalQuery({
  args: {},
  handler: async (ctx) => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(20000);
    const real = msgs.filter((m) => !m.thread_id.startsWith("__probe__"));

    // Group by thread, oldest first.
    const byThread = new Map<string, typeof real>();
    for (const m of real) {
      const arr = byThread.get(m.thread_id) ?? [];
      arr.push(m);
      byThread.set(m.thread_id, arr);
    }
    for (const arr of byThread.values())
      arr.sort((a, b) => (a.hygglo_sent_at ?? 0) - (b.hygglo_sent_at ?? 0));

    let pairs = 0;
    let pairsAfterNoise = 0;
    const byAccount: Record<string, number> = {};
    const threadsWithPairs = new Set<string>();
    const replyLengths: number[] = [];
    const samples: Array<{ thread: string; ask: string; reply: string }> = [];

    for (const [tid, arr] of byThread) {
      for (let i = 0; i < arr.length - 1; i++) {
        const cur = arr[i];
        const next = arr[i + 1];
        if (cur.sender !== "renter" || next.sender !== "owner") continue;
        pairs++;

        const ask = (cur.body_text ?? "").trim();
        const reply = (next.body_text ?? "").trim();
        // Drop pairs that cannot teach us anything: platform notices, empty or
        // near-empty asks, and one-word acknowledgements ("ok", "thanks") where
        // any reply is as good as any other.
        if (SYSTEM_NOTICE.test(ask) || SYSTEM_NOTICE.test(reply)) continue;
        if (ask.length < 12 || reply.length < 20) continue;
        if (/^(ok|okay|thanks|thank you|cheers|great|perfect|👍)[.!\s]*$/i.test(ask)) continue;

        pairsAfterNoise++;
        threadsWithPairs.add(tid);
        byAccount[cur.account_slug] = (byAccount[cur.account_slug] ?? 0) + 1;
        replyLengths.push(reply.length);
        if (samples.length < 5)
          samples.push({
            thread: tid,
            ask: ask.replace(/\s+/g, " ").slice(0, 100),
            reply: reply.replace(/\s+/g, " ").slice(0, 120),
          });
      }
    }

    // Do those threads have items the bot can actually ground an answer in?
    let withItems = 0;
    let withoutItems = 0;
    for (const tid of threadsWithPairs) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_thread", (q) => q.eq("thread_id", tid))
        .first();
      if (conv?.inquiry_items?.length) withItems++;
      else withoutItems++;
    }

    replyLengths.sort((a, b) => a - b);
    const median = replyLengths[Math.floor(replyLengths.length / 2)] ?? 0;

    return {
      threads_scanned: byThread.size,
      raw_renter_then_owner_pairs: pairs,
      usable_pairs_after_noise_filter: pairsAfterNoise,
      threads_contributing_pairs: threadsWithPairs.size,
      pairs_by_account: byAccount,
      threads_with_resolvable_items: withItems,
      threads_without_items: withoutItems,
      median_owner_reply_chars: median,
      samples,
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_shadow_candidates.scan, {}),
});
