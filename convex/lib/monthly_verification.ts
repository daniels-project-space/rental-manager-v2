import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { countPlatformFallout } from "./platform_fallout";
import { dedupByLogicalRental, dedupKey } from "./reservations/predicates";

type Reservation = Doc<"reservations">;
type Signal = Reservation["hygglo_system_signal"];

// The original date partitions remain the exact fallback for ancient rows
// without a provider/import identity and unexpectedly large duplicate groups.
async function allMonthlyRows(ctx: QueryCtx, start: number, end: number) {
  const groups = await Promise.all([
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.gte("obsolete_at", start).lt("obsolete_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.eq("obsolete_at", undefined).gte("v1_updated_at", start).lt("v1_updated_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_fallout_dates", (q) =>
      q.eq("obsolete_at", undefined).eq("v1_updated_at", undefined)
        .gte("_creationTime", start).lt("_creationTime", end)).collect(),
  ]);
  return groups.flat();
}

function signalRows(ctx: QueryCtx, signal: Signal, start: number, end: number) {
  return Promise.all([
    ctx.db.query("reservations").withIndex("by_signal_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).gte("obsolete_at", start).lt("obsolete_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("obsolete_at", undefined)
        .gte("v1_updated_at", start).lt("v1_updated_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("obsolete_at", undefined).eq("v1_updated_at", undefined)
        .gte("_creationTime", start).lt("_creationTime", end)).collect(),
  ]);
}

function obsoleteSignalRows(ctx: QueryCtx, signal: Signal, start: number, end: number) {
  return Promise.all([
    ctx.db.query("reservations").withIndex("by_signal_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("is_obsolete", true)
        .gte("obsolete_at", start).lt("obsolete_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("is_obsolete", true).eq("obsolete_at", undefined)
        .gte("v1_updated_at", start).lt("v1_updated_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("is_obsolete", true).eq("obsolete_at", undefined).eq("v1_updated_at", undefined)
        .gte("_creationTime", start).lt("_creationTime", end)).collect(),
  ]);
}

function terminalSignalRows(
  ctx: QueryCtx, signal: Signal, status: string, obsolete: false | undefined, start: number, end: number,
) {
  return Promise.all([
    ctx.db.query("reservations").withIndex("by_signal_status_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("status", status).eq("is_obsolete", obsolete)
        .gte("obsolete_at", start).lt("obsolete_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_status_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("status", status).eq("is_obsolete", obsolete).eq("obsolete_at", undefined)
        .gte("v1_updated_at", start).lt("v1_updated_at", end)).collect(),
    ctx.db.query("reservations").withIndex("by_signal_status_obsolete_fallout_dates", (q) =>
      q.eq("hygglo_system_signal", signal).eq("status", status).eq("is_obsolete", obsolete)
        .eq("obsolete_at", undefined).eq("v1_updated_at", undefined)
        .gte("_creationTime", start).lt("_creationTime", end)).collect(),
  ]);
}

function reportingOrder(a: Reservation, b: Reservation): number {
  const group = (row: Reservation) => row.obsolete_at !== undefined ? 0 : row.v1_updated_at !== undefined ? 1 : 2;
  const compareOptional = (x: number | undefined, y: number | undefined) =>
    x === y ? 0 : x === undefined ? -1 : y === undefined ? 1 : x - y;
  return group(a) - group(b) ||
    compareOptional(a.obsolete_at, b.obsolete_at) ||
    compareOptional(a.v1_updated_at, b.v1_updated_at) ||
    a._creationTime - b._creationTime;
}

async function monthlyVerificationRows(ctx: QueryCtx, start: number, end: number, account: string | null) {
  const legacySignals: Signal[] = [undefined, "none", "approved"];
  const groups = await Promise.all([
    signalRows(ctx, "verification_failed", start, end),
    ...legacySignals.flatMap((signal) => [
      obsoleteSignalRows(ctx, signal, start, end),
      ...["cancelled", "declined"].flatMap((status) => [
        terminalSignalRows(ctx, signal, status, false, start, end),
        terminalSignalRows(ctx, signal, status, undefined, start, end),
      ]),
    ]),
  ]);
  const inReport = (row: Reservation) => {
    const date = row.obsolete_at ?? row.v1_updated_at ?? row._creationTime;
    return date >= start && date < end && (!account || row.account_slug === account) &&
      (row.is_obsolete === true || row.status === "cancelled" || row.status === "declined");
  };
  const candidates = groups.flat(2).filter((row) => inReport(row) &&
    countPlatformFallout([row]).failed_security_checks_count > 0);
  const identities = new Map(candidates.map((row) => [dedupKey(row), row]));
  if ([...identities.values()].some((row) => !row.hygglo_order_id && !row.v1_rental_id)) {
    return (await allMonthlyRows(ctx, start, end)).filter(inReport);
  }

  // A higher-valued duplicate carrying another signal can suppress a failure
  // in the existing dedup rule. Read each candidate's complete identity group
  // before classifying. Nine copies trigger the old dated path, never truncation.
  const expanded: Reservation[] = [];
  for (const [key, row] of identities) {
    const copies = row.hygglo_order_id
      ? await ctx.db.query("reservations").withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", row.hygglo_order_id)).take(9)
      : await ctx.db.query("reservations").withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", row.v1_rental_id)).take(9);
    if (copies.length === 9) return (await allMonthlyRows(ctx, start, end)).filter(inReport);
    expanded.push(...copies.filter((copy) => inReport(copy) && dedupKey(copy) === key));
  }
  const ordered = [...new Map([...candidates, ...expanded].map((row) => [row._id, row])).values()].sort(reportingOrder);
  // Preserve the database's ordering even for imported rows sharing every
  // index key and creation timestamp; net-value ties retain the first row.
  if (ordered.some((row, i) => i > 0 && reportingOrder(ordered[i - 1], row) === 0)) {
    return (await allMonthlyRows(ctx, start, end)).filter(inReport);
  }
  return ordered;
}

/** Indexed event-date reads; no reservation-history scan or weekly cache. */
export async function loadMonthlyVerificationLosses(
  ctx: QueryCtx, month: string, accountSlug: string | null,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid reporting month");
  const [year, number] = month.split("-").map(Number);
  const start = Date.UTC(year, number - 1, 1);
  const end = Date.UTC(year, number, 1);
  const rows = dedupByLogicalRental(await monthlyVerificationRows(ctx, start, end, accountSlug));
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
