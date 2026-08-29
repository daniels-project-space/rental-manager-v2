/**
 * Shadow evaluation — replay real historical threads and compare the bot's
 * draft to the reply Daniel actually sent.
 *
 * Everything else that grades this bot was written by me: my scenarios, my
 * rubric, my idea of a good answer. Daniel's real replies are the only
 * yardstick in the building that nobody here invented, and there are ~3,400
 * replayable renter-then-owner pairs sitting in `hygglo_messages`.
 *
 * SAFETY. This is read-only over history and writes only `__probe__` threads,
 * the same test-only path the probe harness already uses. It does not import
 * hygglo-write, does not touch renter_bot_drafts, and cannot reach a real
 * renter. The automated send path is hardcoded off regardless.
 *
 * WHAT IT CANNOT DO, stated up front rather than discovered in the numbers: a
 * thread from June replayed today runs against today's calendar and today's
 * stock. Answers about specific dates being free will differ for reasons that
 * have nothing to do with the bot. `shadow_compare` separates those out as
 * incomparable instead of scoring them.
 */
import { action, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { compareToReal, type ShadowVerdict } from "./lib/shadow_compare";

/** Hygglo platform notices are stored with sender "renter" but no person said them. */
const SYSTEM_NOTICE =
  /\bA message was hidden\b|\bWe hid a message\b|\bHygglo (shares|never|will|does not)\b|\b(leave a review|rate your)\b/i;

export type ShadowCandidate = {
  thread_id: string;
  account_slug: string;
  /** Everything up to and including the renter's question. */
  prefix: Array<{ role: string; text: string }>;
  ask: string;
  /** Ground truth: what Daniel actually sent next. */
  real_reply: string;
  items: Array<{ name: string; product_id?: number }>;
  has_items: boolean;
};

/**
 * Mine real threads for replayable points.
 *
 * Sampling is deterministic (evenly spaced over the eligible set) rather than
 * random, so a re-run measures the same exchanges and a change in the score is
 * a change in the bot, not a change in the sample.
 */
export const pickCandidates = internalQuery({
  args: {
    limit: v.number(),
    require_items: v.optional(v.boolean()),
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { limit, require_items, account_slug }): Promise<ShadowCandidate[]> => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(20000);
    const real = msgs.filter(
      (m) => !m.thread_id.startsWith("__probe__") && (!account_slug || m.account_slug === account_slug),
    );

    const byThread = new Map<string, typeof real>();
    for (const m of real) {
      const arr = byThread.get(m.thread_id) ?? [];
      arr.push(m);
      byThread.set(m.thread_id, arr);
    }
    for (const arr of byThread.values())
      arr.sort((a, b) => (a.hygglo_sent_at ?? 0) - (b.hygglo_sent_at ?? 0));

    // Build the eligible pairs WITHOUT touching conversations/reservations.
    // Resolving items for all ~3,000 threads up front blows Convex's 4,096-read
    // ceiling, so the sample is chosen first and only those threads are joined.
    type Pair = Omit<ShadowCandidate, "items" | "has_items">;
    const eligible: Pair[] = [];
    for (const [tid, arr] of byThread) {
      for (let i = 0; i < arr.length - 1; i++) {
        const cur = arr[i];
        const next = arr[i + 1];
        if (cur.sender !== "renter" || next.sender !== "owner") continue;
        const ask = (cur.body_text ?? "").trim();
        const reply = (next.body_text ?? "").trim();
        if (SYSTEM_NOTICE.test(ask) || SYSTEM_NOTICE.test(reply)) continue;
        if (ask.length < 12 || reply.length < 20) continue;
        if (/^(ok|okay|thanks|thank you|cheers|great|perfect)[.!\s]*$/i.test(ask)) continue;

        eligible.push({
          thread_id: tid,
          account_slug: cur.account_slug,
          prefix: arr.slice(0, i + 1).map((m) => ({
            role: m.sender === "owner" ? "owner" : "renter",
            text: m.body_text ?? "",
          })),
          ask,
          real_reply: reply,
        });
      }
    }

    // Even spacing across the eligible set, so the sample spans accounts, item
    // types and eras instead of clustering on whatever sorted first. Oversample
    // because `require_items` will drop some, and each join costs 2 reads.
    const want = require_items ? limit * 6 : limit;
    const picked =
      eligible.length <= want
        ? eligible
        : Array.from(
            { length: want },
            (_, k) => eligible[Math.floor(k * (eligible.length / want))],
          );

    // Now join items for the sampled threads only — reservation first, then the
    // inquiry listing, the same order the real draft route resolves them in.
    const itemCache = new Map<string, Array<{ name: string; product_id?: number }>>();
    const out: ShadowCandidate[] = [];
    for (const p of picked) {
      if (out.length >= limit) break;
      let items = itemCache.get(p.thread_id);
      if (!items) {
        const resv = await ctx.db
          .query("reservations")
          // Hygglo conflates order and conversation, so the thread id IS the
          // order id — that is how the rest of the codebase joins these tables.
          .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", p.thread_id))
          .first();
        const fromResv = (resv?.hygglo_items ?? []).map((h) => ({
          name: h.name ?? "",
          product_id: typeof h.product_id === "number" ? h.product_id : undefined,
        }));
        if (fromResv.some((i) => i.name)) {
          items = fromResv.filter((i) => i.name);
        } else {
          const conv = await ctx.db
            .query("conversations")
            .withIndex("by_thread", (q) => q.eq("thread_id", p.thread_id))
            .first();
          items = (conv?.inquiry_items ?? [])
            .map((i) => ({
              name: i.name,
              product_id: (i as { product_id?: number }).product_id,
            }))
            .filter((i) => i.name);
        }
        itemCache.set(p.thread_id, items);
      }
      if (require_items && items.length === 0) continue;
      out.push({ ...p, items, has_items: items.length > 0 });
    }
    return out;
  },
});

export type ShadowResult = {
  thread_id: string;
  account_slug: string;
  ask: string;
  real_reply: string;
  draft: string;
  has_items: boolean;
  item_names: string[];
  verdicts: ShadowVerdict[];
  defects: number;
  divergences: number;
  incomparable: number;
  no_draft_reason?: string;
};

/**
 * Replay a sample and score it. Each candidate is seeded into its own
 * `__probe__` thread, run through the REAL draft pipeline, then compared.
 */
export const runSample = action({
  args: {
    limit: v.optional(v.number()),
    require_items: v.optional(v.boolean()),
    account_slug: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { limit = 25, require_items = true, account_slug },
  ): Promise<{
    sampled: number;
    results: ShadowResult[];
    totals: Record<string, number>;
    by_category: Record<string, Record<string, number>>;
  }> => {
    const cands: ShadowCandidate[] = await ctx.runQuery(
      internal.renter_bot_shadow.pickCandidates,
      { limit, require_items, account_slug },
    );

    const results: ShadowResult[] = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const tid = `__probe__shadow_${c.thread_id}_${i}`;
      await ctx.runMutation(internal.renter_bot_probe.seed, {
        thread_id: tid,
        account_slug: c.account_slug,
        // Cap the replayed history: the draft route only needs recent context,
        // and a 60-message thread would blow the prompt budget for no gain.
        items: c.items.slice(0, 6),
        messages: c.prefix.slice(-12),
      });

      let draft = "";
      let reason: string | undefined;
      try {
        const res = (await ctx.runAction(api.replyInbox_actions.generateDraft, {
          thread_id: tid,
        })) as { draft?: string; reason?: string } | null;
        draft = res?.draft ?? "";
        reason = res?.reason;
      } catch (e) {
        reason = `error: ${String(e).slice(0, 120)}`;
      }

      const cmp = compareToReal({ ask: c.ask, realReply: c.real_reply, draft });
      results.push({
        thread_id: c.thread_id,
        account_slug: c.account_slug,
        ask: c.ask,
        real_reply: c.real_reply,
        draft,
        has_items: c.has_items,
        item_names: c.items.map((it) => it.name),
        verdicts: cmp.verdicts,
        defects: cmp.defects,
        divergences: cmp.divergences,
        incomparable: cmp.incomparable,
        no_draft_reason: draft ? undefined : reason,
      });
    }

    await ctx.runMutation(api.renter_bot_probe.cleanup, {});

    const totals = {
      exchanges: results.length,
      with_defects: results.filter((r) => r.defects > 0).length,
      total_defects: results.reduce((s, r) => s + r.defects, 0),
      total_divergences: results.reduce((s, r) => s + r.divergences, 0),
      no_draft: results.filter((r) => !r.draft).length,
    };
    const by_category: Record<string, Record<string, number>> = {};
    for (const r of results)
      for (const v2 of r.verdicts) {
        by_category[v2.category] ??= {};
        by_category[v2.category][v2.status] = (by_category[v2.category][v2.status] ?? 0) + 1;
      }

    return { sampled: results.length, results, totals, by_category };
  },
});
