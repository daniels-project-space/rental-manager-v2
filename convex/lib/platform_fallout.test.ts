import { describe, expect, it } from "vitest";
import { countPlatformFallout } from "./platform_fallout";

describe("countPlatformFallout", () => {
  it("counts the authoritative Hygglo renter-cancellation and security-failure events", () => {
    expect(
      countPlatformFallout([
        { status: "cancelled", hygglo_system_signal: "renter_cancelled" },
        { is_obsolete: true, hygglo_system_signal: "verification_failed" },
        { status: "confirmed", hygglo_system_signal: "renter_cancelled" },
      ]),
    ).toEqual({
      renter_cancelled_pending_count: 1,
      failed_security_checks_count: 1,
      expected_rent_lost_gbp: 0,
      failed_security_checks_lost_gbp: 0,
    });
  });

  it("uses legacy structural signals only when Hygglo has no decisive signal", () => {
    expect(
      countPlatformFallout([
        {
          status: "cancelled",
          obsolete_reason: "renter_cancelled",
          order_step: "CANCELED",
        },
        {
          is_obsolete: true,
          order_step: "VERIFICATION_FAILED",
        },
        // Legacy polling predates blue-text capture. This is the importer’s
        // canonical verified-stage failure classification and must still count.
        {
          is_obsolete: true,
          obsolete_reason: "verification_failed",
        },
        // A decisive platform signal wins over an inconsistent legacy field.
        {
          is_obsolete: true,
          hygglo_system_signal: "owner_denied",
          obsolete_reason: "verification_failed",
        },
      ]),
    ).toEqual({
      renter_cancelled_pending_count: 1,
      failed_security_checks_count: 2,
      expected_rent_lost_gbp: 0,
      failed_security_checks_lost_gbp: 0,
    });
  });

  it("sums only the recorded net booking value for classified fallout", () => {
    expect(
      countPlatformFallout([
        { is_obsolete: true, hygglo_system_signal: "renter_cancelled", net_to_owner_gbp: 120 },
        { is_obsolete: true, hygglo_system_signal: "verification_failed", gross_paid_gbp: 100 },
        { is_obsolete: true, hygglo_system_signal: "owner_denied", net_to_owner_gbp: 999 },
      ]),
    ).toMatchObject({
      renter_cancelled_pending_count: 1,
      failed_security_checks_count: 1,
      expected_rent_lost_gbp: 184,
      failed_security_checks_lost_gbp: 64,
    });
  });
});

// Exercise the live reader's indexed date partitions, including imported rows
// and rentals scheduled in another month; the reporting month is the event month.
import { loadMonthlyVerificationLosses } from "./monthly_verification";
import type { QueryCtx } from "../_generated/server";

describe("monthly failed-verification reader", () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const end = Date.parse("2026-11-01T00:00:00Z");
  const event = (id: string, extra: Record<string, unknown>) => ({
    _id: id, hygglo_order_id: id, _creationTime: start - 90 * 86_400_000, account_slug: "leo",
    status: "cancelled", is_obsolete: true, hygglo_system_signal: "verification_failed",
    start_date: "2026-12-01", ...extra,
  });
  const rows = [
    event("new", { obsolete_at: start, net_to_owner_gbp: 100 }),
    event("legacy-update", { v1_updated_at: start + 100, gross_paid_gbp: 100 }),
    event("legacy-created", { _creationTime: start + 200 }),
    event("next-month", { obsolete_at: end, net_to_owner_gbp: 999 }),
    event("previous-event", { obsolete_at: start - 1, v1_updated_at: start + 100, net_to_owner_gbp: 999 }),
    event("other-account", { obsolete_at: start, account_slug: "diogo", net_to_owner_gbp: 50 }),
    event("renter-cancelled", { obsolete_at: start, hygglo_system_signal: "renter_cancelled", net_to_owner_gbp: 888 }),
    event("recovered", { obsolete_at: start, status: "confirmed", is_obsolete: false, net_to_owner_gbp: 777 }),
  ];
  const ctx = {
    db: { query: () => ({ withIndex: (_: string, build: (q: unknown) => unknown) => {
      const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
      const range = {
        eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return range; },
        gte(key: string, value: number) { predicates.push((row) => typeof row[key] === "number" && (row[key] as number) >= value); return range; },
        lt(key: string, value: number) { predicates.push((row) => typeof row[key] === "number" && (row[key] as number) < value); return range; },
      };
      build(range);
      return { collect: async () => rows.filter((row) => predicates.every((test) => test(row))) };
    } }) },
  } as unknown as QueryCtx;

  it("counts failure dates with legacy fallbacks and known prices, without other cancellations", async () => {
    const result = await loadMonthlyVerificationLosses(ctx, "2026-10", "leo");
    expect(result.failed_security_checks_count).toBe(3);
    expect(result.failed_security_checks_lost_gbp).toBe(164);
    expect(result.unvalued_count).toBe(1);
    expect(result.scheduled_month).toBe("2026-10");
  });
  it("combines accounts and uses an exclusive month end", async () => {
    const all = await loadMonthlyVerificationLosses(ctx, "2026-10", null);
    expect(all.failed_security_checks_count).toBe(4);
    expect(all.failed_security_checks_lost_gbp).toBe(214);
    const next = await loadMonthlyVerificationLosses(ctx, "2026-11", null);
    expect(next.failed_security_checks_count).toBe(1);
    expect(next.failed_security_checks_lost_gbp).toBe(999);
  });
});
