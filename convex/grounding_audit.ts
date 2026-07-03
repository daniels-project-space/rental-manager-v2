/**
 * grounding_audit — how often a draft is actually GROUNDED (has a resolvable
 * product_id → real listing facts) vs handed a bare name to guess about.
 * Now also reports the coverage AFTER lever 5's name→listing recovery, so we
 * can see the gap the fallback closes. One-off diagnostic; read-only.
 */
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

const STOP = new Set(["the", "and", "for", "with", "plus", "set", "kit", "bundle", "combo"]);
const toks = (str: string) =>
  Array.from(
    new Set(
      (str.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
        (t) => t.length > 1 && !STOP.has(t),
      ),
    ),
  );

export const audit = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 400 }) => {
    const convs = await ctx.db.query("conversations").order("desc").take(limit);
    // Cache listing token-sets per account for the recovery match.
    const listingsByAccount = new Map<string, Array<{ pid: number; tset: Set<string> }>>();
    const loadListings = async (slug: string) => {
      let ls = listingsByAccount.get(slug);
      if (!ls) {
        const rows = await ctx.db
          .query("online_listings")
          .withIndex("by_account", (q) => q.eq("account_slug", slug))
          .collect();
        ls = rows.map((l) => ({ pid: l.product_id, tset: new Set(toks(l.name)) }));
        listingsByAccount.set(slug, ls);
      }
      return ls;
    };
    const bestPid = (name: string, ls: Array<{ pid: number; tset: Set<string> }>) => {
      const q = toks(name);
      if (q.length < 2) return null;
      let best: number | null = null;
      let bestScore = 0;
      let bestSize = Infinity;
      for (const L of ls) {
        let hit = 0;
        for (const t of q) if (L.tset.has(t)) hit++;
        if (hit < 2) continue;
        const score = hit / q.length;
        if (score > bestScore || (score === bestScore && L.tset.size < bestSize)) {
          best = L.pid;
          bestScore = score;
          bestSize = L.tset.size;
        }
      }
      return bestScore >= 0.6 ? best : null;
    };

    let withItems = 0;
    let storedGrounded = 0;
    let recoveredGrounded = 0;
    const stillMissing: string[] = [];
    for (const c of convs) {
      const items = (c.inquiry_items ?? []) as Array<{ name?: string; product_id?: number }>;
      if (!items.length) continue;
      withItems++;
      const hasStored = items.some((i) => typeof i.product_id === "number");
      if (hasStored) {
        storedGrounded++;
        recoveredGrounded++;
        continue;
      }
      // ungrounded: try the name fallback
      const slug = c.account_slug as string | undefined;
      let recovered = false;
      if (slug) {
        const ls = await loadListings(slug);
        recovered = items.some((i) => i.name && bestPid(i.name, ls) !== null);
      }
      if (recovered) recoveredGrounded++;
      else if (stillMissing.length < 10)
        stillMissing.push(items.map((i) => i.name ?? "?").join(" + "));
    }
    return {
      threadsWithItems: withItems,
      storedGroundedPct: withItems ? Math.round((storedGrounded / withItems) * 100) : 0,
      recoveredGroundedPct: withItems ? Math.round((recoveredGrounded / withItems) * 100) : 0,
      stillUngroundedExamples: stillMissing,
    };
  },
});
