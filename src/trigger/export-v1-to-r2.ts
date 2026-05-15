/**
 * One-off Trigger.dev task: export every v1-imported reservation in Convex
 * to R2 cold storage, plus three aggregate indexes for query patterns:
 *
 *   by_item   { [item_id]: { totalGross, totalNet, rentalCount, totalDays,
 *                            byMonth: { "YYYY-MM": gross } } }
 *   by_renter { [renter_name]: { totalGross, rentalCount, firstDate, lastDate } }
 *   by_month  { "YYYY-MM": { totalGross, totalNet, rentalCount } }
 *   totals    { totalGross, totalNet, rentalCount, byAccount: {...} }
 *
 * After this runs successfully, v1 reservations can be deleted from
 * Convex (84% of the table) and per-item / per-renter / per-month
 * queries served from R2 instead.
 *
 * Invocation: tested locally first via `npx trigger.dev dev`, then run
 * once in prod via the Trigger.dev dashboard. Idempotent — re-running
 * overwrites the same R2 keys.
 *
 * NOTE: does NOT delete from Convex. Manual verification + a separate
 * teardown task gates that.
 */
import { task, logger } from "@trigger.dev/sdk/v3";
import {
  putReservationSnapshot,
  putAggregateIndex,
  type ReservationSnapshot,
} from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

type RawReservation = ReservationSnapshot & {
  _id: string;
  v1_rental_id?: string;
  account_slug?: string;
  // Pulled from listForReconcile — full row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

async function fetchAccount(slug: string): Promise<RawReservation[]> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "reservations:listForReconcile",
      args: { account_slug: slug },
      format: "json",
    }),
  });
  const data = (await res.json()) as {
    status: string;
    value?: RawReservation[];
    errorMessage?: string;
  };
  if (data.status !== "success") {
    throw new Error(`listForReconcile(${slug}) failed: ${data.errorMessage}`);
  }
  return data.value ?? [];
}

export const exportV1ToR2 = task({
  id: "export-v1-to-r2",
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    logger.info("export-v1-to-r2: starting", { runId: ctx.run.id });

    // 1. Pull everything (still ~1767 rows, single pull each account).
    const dbcinema = await fetchAccount("dbcinema");
    const leo = await fetchAccount("leo");
    const all: RawReservation[] = [...dbcinema, ...leo];
    const v1 = all.filter((r) => r.v1_rental_id);
    logger.info("export-v1-to-r2: fetched", {
      total: all.length,
      v1: v1.length,
    });

    // 2. Write per-rental snapshots
    let written = 0;
    let failed = 0;
    for (const r of v1) {
      try {
        // Strip Convex internals before serialising.
        const snap: ReservationSnapshot = {
          v1_rental_id: r.v1_rental_id as string,
          hygglo_order_id: r.hygglo_order_id ?? null,
          account_slug: r.account_slug,
          start_date: r.start_date,
          end_date: r.end_date,
          pickup_date: r.pickup_date,
          status: r.status,
          gross_paid_gbp: r.gross_paid_gbp,
          net_to_owner_gbp: r.net_to_owner_gbp,
          platform_fee_gbp: r.platform_fee_gbp,
          duration_days: r.duration_days,
          notes: r.notes,
          renter_name: r.renter_name,
          resolved_items: r.resolved_items,
        };
        await putReservationSnapshot(snap);
        written++;
        if (written % 100 === 0) {
          logger.info(`export-v1-to-r2: ${written}/${v1.length} written`);
        }
      } catch (err) {
        failed++;
        logger.warn("export-v1-to-r2: snapshot write failed", {
          v1_rental_id: r.v1_rental_id,
          err: String(err),
        });
      }
    }

    // 3. Build aggregate indexes
    interface ItemAgg {
      itemId: string;
      itemNameCanonical: string;
      totalGross: number;
      totalNet: number;
      rentalCount: number;
      totalDays: number;
      byMonth: Record<string, number>;
    }
    const byItem = new Map<string, ItemAgg>();
    const byRenter = new Map<
      string,
      { name: string; totalGross: number; rentalCount: number; firstDate: string; lastDate: string }
    >();
    const byMonth = new Map<string, { totalGross: number; totalNet: number; rentalCount: number }>();
    let grandGross = 0;
    let grandNet = 0;
    const byAccount: Record<string, { totalGross: number; rentalCount: number }> = {};

    for (const r of v1) {
      const gross = r.gross_paid_gbp ?? 0;
      const net = r.net_to_owner_gbp ?? 0;
      const eff = r.pickup_date ?? r.start_date;
      const monthKey = eff?.slice(0, 7) ?? "unknown";

      grandGross += gross;
      grandNet += net;

      // by account
      if (r.account_slug) {
        const a = byAccount[r.account_slug] ?? { totalGross: 0, rentalCount: 0 };
        a.totalGross += gross;
        a.rentalCount += 1;
        byAccount[r.account_slug] = a;
      }

      // by month
      const mo = byMonth.get(monthKey) ?? { totalGross: 0, totalNet: 0, rentalCount: 0 };
      mo.totalGross += gross;
      mo.totalNet += net;
      mo.rentalCount += 1;
      byMonth.set(monthKey, mo);

      // by item — uses resolved_items (migration ported v1's per-row attribution)
      for (const x of r.resolved_items ?? []) {
        const itemId = x.item_id as string;
        const itemName = x.item_name_canonical;
        const itemShare = typeof x.revenue_gbp === "number"
          ? x.revenue_gbp
          : (r.resolved_items?.length ? gross / r.resolved_items.length : gross);
        const itemNet = typeof x.revenue_gbp === "number" && gross > 0
          ? (x.revenue_gbp / gross) * net
          : (r.resolved_items?.length ? net / r.resolved_items.length : net);
        const cur = byItem.get(itemId) ?? {
          itemId,
          itemNameCanonical: itemName,
          totalGross: 0,
          totalNet: 0,
          rentalCount: 0,
          totalDays: 0,
          byMonth: {},
        };
        cur.totalGross += itemShare;
        cur.totalNet += itemNet;
        cur.rentalCount += 1;
        cur.totalDays += r.duration_days ?? 0;
        cur.byMonth[monthKey] = (cur.byMonth[monthKey] ?? 0) + itemShare;
        byItem.set(itemId, cur);
      }

      // by renter
      if (r.renter_name) {
        const name = r.renter_name;
        const cur = byRenter.get(name) ?? {
          name,
          totalGross: 0,
          rentalCount: 0,
          firstDate: eff ?? "",
          lastDate: eff ?? "",
        };
        cur.totalGross += gross;
        cur.rentalCount += 1;
        if (eff && (!cur.firstDate || eff < cur.firstDate)) cur.firstDate = eff;
        if (eff && eff > cur.lastDate) cur.lastDate = eff;
        byRenter.set(name, cur);
      }
    }

    // Round all currency values once, server-side.
    const round = (n: number) => Math.round(n * 100) / 100;
    const byItemOut = Object.fromEntries(
      [...byItem.entries()].map(([k, v]) => [
        k,
        {
          ...v,
          totalGross: round(v.totalGross),
          totalNet: round(v.totalNet),
          byMonth: Object.fromEntries(
            Object.entries(v.byMonth).map(([m, g]) => [m, round(g)]),
          ),
        },
      ]),
    );
    const byRenterOut = Object.fromEntries(
      [...byRenter.entries()].map(([k, v]) => [k, { ...v, totalGross: round(v.totalGross) }]),
    );
    const byMonthOut = Object.fromEntries(
      [...byMonth.entries()].map(([k, v]) => [
        k,
        { totalGross: round(v.totalGross), totalNet: round(v.totalNet), rentalCount: v.rentalCount },
      ]),
    );
    const totalsOut = {
      totalGross: round(grandGross),
      totalNet: round(grandNet),
      rentalCount: v1.length,
      byAccount: Object.fromEntries(
        Object.entries(byAccount).map(([k, v]) => [k, { ...v, totalGross: round(v.totalGross) }]),
      ),
      generatedAt: Date.now(),
    };

    await putAggregateIndex("by_item", byItemOut);
    await putAggregateIndex("by_renter", byRenterOut);
    await putAggregateIndex("by_month", byMonthOut);
    await putAggregateIndex("totals", totalsOut);

    logger.info("export-v1-to-r2: complete", {
      v1Count: v1.length,
      snapshotsWritten: written,
      snapshotsFailed: failed,
      uniqueItems: byItem.size,
      uniqueRenters: byRenter.size,
      uniqueMonths: byMonth.size,
      grandGross: totalsOut.totalGross,
    });
    return {
      ok: true,
      v1Count: v1.length,
      snapshotsWritten: written,
      snapshotsFailed: failed,
      indexes: {
        items: byItem.size,
        renters: byRenter.size,
        months: byMonth.size,
      },
    };
  },
});
