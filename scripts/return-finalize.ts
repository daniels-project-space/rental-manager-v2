/**
 * return-finalize — adapts v1's "mark as returned" + the post-rental discount /
 * review message into the v2 CLI, routed through the SINGLE gated write
 * chokepoint (src/lib/hygglo-write.ts). READ-ONLY by default: with
 * READ_ONLY_MODE unset or "true", every write returns {status:'skipped'} and
 * NOTHING reaches Hygglo.
 *
 *   READ-ONLY (default):  ./node_modules/.bin/tsx scripts/return-finalize.ts
 *   LIVE (future, gated):  READ_ONLY_MODE=false ./node_modules/.bin/tsx scripts/return-finalize.ts
 *
 * Idempotency: the platform CLOSE runs first. Only when it actually returns
 * `sent` do we (a) message the renter and (b) stamp `platform_closed_at` so the
 * row drops out of `pendingPlatformClose`. A skipped (READ-ONLY) or failed close
 * therefore never sends a message and the row is retried cleanly next run — no
 * re-mark / re-spam loop.
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
    // Close (mark returned) FIRST — this is the irreversible platform action.
    const c = await returnOrder(base);
    console.log(`  close ${r.hygglo_order_id}: ${c.status}${c.reason ? " (" + c.reason + ")" : ""}`);
    if (c.status !== "sent") continue; // skipped (read-only) or failed → no message, no stamp, retry next run

    // Only good renters carry a review_message (markReturned suppresses it for
    // flagged/blacklisted), so this naturally sends the discount only to them.
    if (r.review_message) {
      const m = await sendOrderMessage({ ...base, text: r.review_message });
      console.log(`  msg   ${r.hygglo_order_id}: ${m.status}${m.reason ? " (" + m.reason + ")" : ""}`);
    }

    // Stamp closed so this row is never re-processed.
    await convex.mutation("reservations:markPlatformClosed" as any, { reservationId: r.reservationId });
    console.log(`  stamp ${r.hygglo_order_id}: platform_closed_at set`);
  }
  console.log(ro ? "done (read-only — nothing sent)" : "done");
})().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
