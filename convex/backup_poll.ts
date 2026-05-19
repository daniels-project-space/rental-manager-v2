/**
 * Wave 3a — Backup poller (failsafe).
 *
 * Single on-demand `internalAction` that:
 *   1. Reads Hygglo credentials from the vault for both accounts.
 *   2. Calls `fetchOrdersMinimal` for each — minimal client, capped at 50
 *      orders/account, list + per-order detail only (no chat, no activities).
 *   3. Upserts each order via the existing `api.hygglo.upsertOrderAsReservation`
 *      mutation. That mutation is the working ingestion point used by the
 *      primary Trigger.dev task; reusing it means rows look identical
 *      regardless of which poller produced them.
 *   4. Updates `account_state` via `api.account_state.upsert`.
 *
 * NOT cron-scheduled. Invoked manually or by the Wave 4 staleness alarm:
 *     internal.backup_poll.runBackupPoll
 *
 * Convex action limit: 10 min. Designed to finish in ~60s.
 * Each account runs in its own try/catch so one bad credential doesn't
 * block the other account.
 */

import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { getAccountCredentials } from "../src/lib/hygglo-auth";
import { fetchOrdersMinimal } from "./lib/hygglo_minimal";

const ACCOUNT_SLUGS = ["dbcinema", "leo"] as const;

interface AccountReport {
  account: string;
  ordersFetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  detailErrors: string[];
  fatal?: string;
}

export const runBackupPoll = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    accounts: number;
    orders: number;
    errors: string[];
    perAccount: AccountReport[];
  }> => {
    const startedAt = Date.now();
    const perAccount: AccountReport[] = [];
    const errors: string[] = [];

    for (const slug of ACCOUNT_SLUGS) {
      const report: AccountReport = {
        account: slug,
        ordersFetched: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        detailErrors: [],
      };

      try {
        const { email, password, clientSecret } =
          await getAccountCredentials(slug);

        const { payloads, detailErrors } = await fetchOrdersMinimal({
          accountSlug: slug,
          email,
          password,
          clientSecret,
        });

        report.ordersFetched = payloads.length;
        report.detailErrors = detailErrors;

        for (const p of payloads) {
          try {
            const res = await ctx.runMutation(
              api.hygglo.upsertOrderAsReservation,
              {
                account_slug: slug,
                hygglo_order_id: p.hygglo_order_id,
                status: p.status,
                start_date: p.start_date,
                end_date: p.end_date,
                gross_paid_gbp: p.gross_paid_gbp,
                net_to_owner_gbp: p.net_to_owner_gbp,
                currency: p.currency,
                items: p.items,
                duration_days: p.duration_days,
                order: p.order,
                sourceFilter: p.sourceFilter,
                booking_status: p.booking_status,
                latest_activity: p.latest_activity,
              },
            );
            if (res.action === "inserted") report.inserted++;
            else if (res.action === "updated") report.updated++;
            else report.skipped++;
          } catch (mErr) {
            const msg = `order ${p.hygglo_order_id}: ${
              mErr instanceof Error ? mErr.message : String(mErr)
            }`;
            report.detailErrors.push(msg);
          }
        }

        // Mark account healthy in account_state.
        await ctx.runMutation(api.account_state.upsert, {
          account: slug,
          succeeded: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.fatal = msg;
        errors.push(`${slug}: ${msg}`);
        // Best-effort: record failure in account_state so health dashboards
        // see the backup attempt's outcome. Wrapped in its own try/catch so
        // a vault outage during the failure path doesn't abort the action.
        try {
          await ctx.runMutation(api.account_state.upsert, {
            account: slug,
            succeeded: false,
            errorMessage: msg,
          });
        } catch (saErr) {
          errors.push(
            `${slug}: account_state.upsert failed: ${
              saErr instanceof Error ? saErr.message : String(saErr)
            }`,
          );
        }
      }

      perAccount.push(report);
    }

    const totalOrders = perAccount.reduce(
      (n, r) => n + r.inserted + r.updated + r.skipped,
      0,
    );
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[backup_poll] done in ${elapsedMs}ms — accounts=${perAccount.length} ` +
        `orders=${totalOrders} errors=${errors.length}`,
    );

    return {
      accounts: perAccount.length,
      orders: totalOrders,
      errors,
      perAccount,
    };
  },
});
