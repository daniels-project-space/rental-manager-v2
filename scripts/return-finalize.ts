/**
 * return-finalize — adapts v1's "mark as returned" + the new thank-you/review
 * message into the v2 CLI, routed through the SINGLE gated write chokepoint
 * (src/lib/hygglo-write.ts). READ-ONLY by default: with READ_ONLY_MODE unset or
 * "true", every write returns {status:'skipped'} and NOTHING reaches Hygglo.
 *
 *   READ-ONLY (default):  ./node_modules/.bin/tsx scripts/return-finalize.ts
 *   LIVE (future, gated):  READ_ONLY_MODE=false ./node_modules/.bin/tsx scripts/return-finalize.ts
 */
import { ConvexHttpClient } from "convex/browser";
import { returnOrder, sendOrderMessage } from "../src/lib/hygglo-write";

(async () => {
  const convex = new ConvexHttpClient(process.env.CONVEX_URL || "https://hearty-oyster-600.convex.cloud");
  const pending: any[] = await convex.query("reservations:pendingPlatformClose" as any, {});
  const ro = process.env.READ_ONLY_MODE !== "false";
  console.log(`return-finalize | pending: ${pending.length} | mode: ${ro ? "READ-ONLY (no writes)" : "LIVE"}`);
  for (const r of pending) {
    const base = { accountSlug: r.account_slug, hyggloOrderId: String(r.hygglo_order_id) };
    if (r.review_message) {
      const m = await sendOrderMessage({ ...base, text: r.review_message });
      console.log(`  msg   ${r.hygglo_order_id}: ${m.status}${m.reason ? " (" + m.reason + ")" : ""}`);
    }
    const c = await returnOrder(base);
    console.log(`  close ${r.hygglo_order_id}: ${c.status}${c.reason ? " (" + c.reason + ")" : ""}`);
  }
  console.log("done (read-only — nothing sent)");
})().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
