import type { QueryCtx } from "../_generated/server";
import { countPlatformFallout } from "./platform_fallout";
import { dedupByLogicalRental } from "./reservations/predicates";

/** Indexed event-date reads; no reservation-history scan or weekly cache. */
export async function loadMonthlyVerificationLosses(
  ctx: QueryCtx, month: string, accountSlug: string | null,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid reporting month");
  const [year, number] = month.split("-").map(Number);
  const start = Date.UTC(year, number - 1, 1);
  const end = Date.UTC(year, number, 1);
  const [dated, legacyUpdated, legacyCreated] = await Promise.all([
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.gte("obsolete_at", start).lt("obsolete_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.eq("obsolete_at", undefined).gte("v1_updated_at", start).lt("v1_updated_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.eq("obsolete_at", undefined).eq("v1_updated_at", undefined)
        .gte("_creationTime", start).lt("_creationTime", end)).collect(),
  ]);
  const rows = dedupByLogicalRental([...dated, ...legacyUpdated, ...legacyCreated].filter((r) =>
    (!accountSlug || r.account_slug === accountSlug) &&
    (r.is_obsolete === true || r.status === "cancelled" || r.status === "declined")));
  const counts = countPlatformFallout(rows);
  const unvalued = rows.filter((r) =>
    countPlatformFallout([r]).failed_security_checks_count > 0 &&
    !(r.net_to_owner_gbp && r.net_to_owner_gbp > 0) &&
    !(r.gross_paid_gbp && r.gross_paid_gbp > 0)).length;
  return {
    total_count: counts.failed_security_checks_count,
    failed_security_checks_count: counts.failed_security_checks_count,
    expected_rent_lost_gbp: counts.failed_security_checks_lost_gbp,
    failed_security_checks_lost_gbp: counts.failed_security_checks_lost_gbp,
    unvalued_count: unvalued,
    scheduled_month: month,
    checked_at: Date.now(),
    metric_version: 3,
  };
}
