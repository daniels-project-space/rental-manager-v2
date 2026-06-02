/**
 * Bootstrap the deterministic Hygglo product_id → item_id index from the
 * existing reservations corpus. For each (account_slug, product_id):
 *
 *   • Unanimous resolution across all aligned rows → "auto-bootstrap" entry.
 *   • Split resolution → run the structural sanity check (canonical name
 *     tokens must appear in the listing title with comparison parentheticals
 *     stripped). If exactly one candidate passes → "auto-tiebreak" entry.
 *     If zero or multiple pass → no entry written (manual confirmation
 *     needed later).
 *
 * Idempotent: replaces any existing auto-* entries, leaves manual entries
 * untouched. Safe to re-run.
 */
import { internalMutation } from "./_generated/server";

function stripParentheticalComparisons(s: string): string {
  return s.replace(
    /\([^)]*\b(same|like|equivalent|comparable|as good as|similar|alternative)\b[^)]*\)/gi,
    " ",
  );
}

function buildModelTokens(name: string): string[] {
  const tokens = new Set<string>();
  const re = /\b([a-z]+\d+\w*|[a-z]+\s*[ivx]{1,4}\b|\d+\.\d+|\d+[a-z]+)/gi;
  for (const m of name.toLowerCase().matchAll(re)) {
    tokens.add(m[1].replace(/\s+/g, ""));
  }
  return Array.from(tokens);
}

function passesSanityCheck(canonical: string, listingTitlesRaw: string[]): boolean {
  const tokens = buildModelTokens(canonical);
  if (tokens.length === 0) return false;
  const cleaned = listingTitlesRaw
    .map((t) => stripParentheticalComparisons(t).toLowerCase().replace(/\s+/g, ""));
  return tokens.some((t) => cleaned.some((c) => c.includes(t)));
}

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-off bootstrap (manual run)

    type Evidence = {
      titles: string[]; // raw titles from this row's hygglo_items position
      confidence: number;
    };
    // key: account:product_id → itemId → Evidence[]
    const consensus: Map<string, Map<string, Evidence[]>> = new Map();
    const lastTitleFor: Map<string, string> = new Map();

    for (const r of all) {
      const hItems = ((r as any).hygglo_items ?? []) as Array<{
        name?: string;
        product_id?: number;
      }>;
      const resolved = (r as any).resolved_items as
        | Array<{
            item_id: string;
            qty?: number;
            confidence?: number;
            item_name_canonical?: string;
          }>
        | undefined;
      if (!resolved || resolved.length !== hItems.length) continue;
      for (let i = 0; i < hItems.length; i++) {
        const h = hItems[i];
        const ri = resolved[i];
        if (typeof h.product_id !== "number" || !ri) continue;
        const key = `${(r as any).account_slug}:${h.product_id}`;
        const inner = consensus.get(key) ?? new Map();
        const list = inner.get(String(ri.item_id)) ?? [];
        list.push({ titles: [h.name ?? ""], confidence: ri.confidence ?? 0 });
        inner.set(String(ri.item_id), list);
        consensus.set(key, inner);
        if (h.name) lastTitleFor.set(key, h.name);
      }
    }

    // Wipe existing auto-* entries (manual entries preserved).
    const existing = await ctx.db.query("hygglo_product_index").collect();
    for (const e of existing) {
      if (e.source !== "manual") await ctx.db.delete(e._id);
    }

    let writtenUnanimous = 0;
    let writtenTiebreak = 0;
    let leftAmbiguous = 0;
    const ambiguous: any[] = [];

    for (const [key, inner] of consensus) {
      const [account_slug, productIdStr] = key.split(":");
      const product_id = Number(productIdStr);
      // Skip if a manual entry already exists.
      const manual = existing.find(
        (e) =>
          e.source === "manual" &&
          e.account_slug === account_slug &&
          e.product_id === product_id,
      );
      if (manual) continue;

      const entries = Array.from(inner.entries());
      const sampleTitle = lastTitleFor.get(key);
      const totalEvidence = entries.reduce((s, [, v]) => s + v.length, 0);

      if (entries.length === 1) {
        const [itemId, ev] = entries[0];
        await ctx.db.insert("hygglo_product_index", {
          account_slug,
          product_id,
          item_id: itemId as any,
          source: "auto-bootstrap",
          evidence_count: ev.length,
          created_at: now,
          last_seen_at: now,
          sample_title: sampleTitle,
        });
        writtenUnanimous++;
        continue;
      }

      // Tiebreak: find candidates whose canonical name tokens appear in the
      // cleaned listing title. The poller stores titles per-rental so we
      // collect titles from ALL rentals where this product_id appeared.
      const allTitles: string[] = [];
      for (const [, evList] of entries) {
        for (const ev of evList) allTitles.push(...ev.titles);
      }
      const candidatesPassing: Array<{ itemId: string; evidence: number }> = [];
      for (const [itemId, evList] of entries) {
        const item = await ctx.db.get(itemId as any);
        if (!item) continue;
        const canonical = (item as any).name_canonical ?? "";
        if (passesSanityCheck(canonical, allTitles)) {
          candidatesPassing.push({ itemId, evidence: evList.length });
        }
      }

      if (candidatesPassing.length === 1) {
        const winner = candidatesPassing[0];
        await ctx.db.insert("hygglo_product_index", {
          account_slug,
          product_id,
          item_id: winner.itemId as any,
          source: "auto-tiebreak",
          evidence_count: winner.evidence,
          created_at: now,
          last_seen_at: now,
          sample_title: sampleTitle,
        });
        writtenTiebreak++;
      } else {
        leftAmbiguous++;
        ambiguous.push({
          key,
          totalEvidence,
          candidates: entries.map(([itemId, ev]) => ({ itemId, count: ev.length })),
          candidatesPassingSanity: candidatesPassing.length,
          sampleTitle,
        });
      }
    }

    return {
      writtenUnanimous,
      writtenTiebreak,
      leftAmbiguous,
      ambiguous,
    };
  },
});
