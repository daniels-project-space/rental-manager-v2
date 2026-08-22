"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

/**
 * Backfill real Hygglo descriptions for the unmapped Blackmagic listings.
 *
 * Why: mapping bundles has to be driven by what each listing SAYS it includes,
 * and the descriptions carry an explicit "Included in this rental" bullet list.
 * But `online_listings.description` is only lazily populated (the rescan list
 * endpoint omits it), so ~83% of these listings had no description cached at
 * all — measured, not assumed. Without this step there is nothing to map from.
 *
 * READ-ONLY against Hygglo: GET /v2/my/products/{id} only, the same call the
 * draft path already makes. No PATCH, no order writes, nothing published.
 */

export default internalAction({
  handler: async (ctx): Promise<unknown> => {
    const rows = (await ctx.runQuery(
      internal.backfill_blackmagic_queries.targets,
      {},
    )) as Array<{ account_slug: string; product_id: number }>;

    const byAccount = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byAccount.get(r.account_slug) ?? [];
      arr.push(r.product_id);
      byAccount.set(r.account_slug, arr);
    }

    let fetched = 0;
    let empty = 0;
    let failed = 0;
    for (const [slug, pids] of byAccount.entries()) {
      let token: string;
      try {
        const creds = await getAccountCredentials(slug);
        token = await getHyggloAccessToken({ ...creds, accountSlug: slug });
      } catch {
        failed += pids.length;
        continue;
      }
      for (const pid of pids) {
        try {
          const res = await fetch(`${HYGGLO_API_BASE}/v2/my/products/${pid}`, {
            headers: hyggloAuthHeaders(token),
          });
          if (!res.ok) {
            failed++;
            continue;
          }
          const p = (await res.json()) as { description?: string };
          const desc = (p.description ?? "").replace(/\s+/g, " ").trim();
          if (!desc) {
            empty++;
            continue;
          }
          await ctx.runMutation(internal.online_listings.setDescription, {
            account_slug: slug,
            product_id: pid,
            description: desc,
          });
          fetched++;
        } catch {
          failed++;
        }
      }
    }
    return { targets: rows.length, fetched, empty, failed };
  },
});
