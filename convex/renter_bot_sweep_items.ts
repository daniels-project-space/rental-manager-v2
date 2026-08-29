import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Pick a spread of REAL listings to sweep the bot against.
 *
 * The grounding bugs found so far were all discovered on Sony bodies, because
 * that is what the failing transcript happened to be about. A fix verified only
 * there proves very little: the question is whether the same fault bites on a
 * light, a power station, a microphone or a gimbal, on every account.
 *
 * Spreads across accounts and gear kinds and returns only listings that HAVE
 * price tiers, so a silent reply cannot be blamed on missing catalogue data.
 */
const KINDS: Array<{ kind: string; re: RegExp }> = [
  { kind: "camera", re: /\b(a7|a6|fx3|fx6|fx30|bmpcc|blackmagic|camera|mirrorless|c70|r5|r6)\b/i },
  { kind: "lens", re: /\b(lens|mm\b|anamorphic|sigma|prime|zoom)\b/i },
  { kind: "audio", re: /\b(mic|microphone|rode|sennheiser|boom|lav|wireless go|zoom h\d|recorder)\b/i },
  { kind: "monitor", re: /\b(monitor|atomos|ninja|shogun|feelworld|transmitter|hollyland)\b/i },
  { kind: "light", re: /\b(light|aputure|godox|nanlite|led|softbox|rgb)\b/i },
  { kind: "power", re: /\b(battery|power station|anker|ecoflow|jackery|v-?mount|generator)\b/i },
  { kind: "support", re: /\b(gimbal|tripod|rs ?[234]|ronin|slider|stabilis)\b/i },
];

function kindOf(title: string): string {
  for (const k of KINDS) if (k.re.test(title)) return k.kind;
  return "other";
}

export const pick = internalQuery({
  args: { per_kind: v.optional(v.number()) },
  handler: async (ctx, { per_kind = 1 }) => {
    const products = await ctx.db.query("hygglo_products").take(4000);
    const priced = products.filter(
      (p) => Array.isArray(p.prices) && p.prices.length > 0 && (p.name ?? "").length > 8,
    );

    // Group by kind, then round-robin the accounts inside each kind so one
    // account cannot dominate the sample.
    const byKind = new Map<string, typeof priced>();
    for (const p of priced) {
      const k = kindOf(p.name ?? "");
      const arr = byKind.get(k) ?? [];
      arr.push(p);
      byKind.set(k, arr);
    }

    const out: Array<{ kind: string; account: string; name: string; product_id: number }> = [];
    const accountCursor = new Map<string, number>();
    for (const [kind, rows] of byKind) {
      const accounts = [...new Set(rows.map((r) => r.accountSlug ?? "?"))].sort();
      for (let n = 0; n < per_kind; n++) {
        const ai = (accountCursor.get(kind) ?? 0) % Math.max(accounts.length, 1);
        accountCursor.set(kind, ai + 1);
        const acc = accounts[ai];
        const inAcc = rows.filter((r) => (r.accountSlug ?? "?") === acc);
        const pickRow = inAcc[Math.floor((n * inAcc.length) / Math.max(per_kind, 1)) % inAcc.length];
        if (!pickRow) continue;
        out.push({
          kind,
          account: acc,
          name: pickRow.name ?? "",
          product_id: pickRow.productId,
        });
      }
    }
    return { total_priced_listings: priced.length, picked: out };
  },
});
