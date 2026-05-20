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

        // 2026-05-20: READ-ONLY MODE — backup poller no longer writes via
        // api.hygglo.upsertOrderAsReservation. Earlier full-row overwrite
        // stripped image_url, renter_name, hygglo_system_signal*, photos_urls
        // and other primary-only fields. Backup is now a Hygglo-credentials
        // health probe: if fetchOrdersMinimal returned without throwing, we
        // consider the account "reachable" and clear staleness so Trigger.dev
        // primary remains the only writer. All `skipped` accounting below.
        report.skipped = payloads.length;

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
