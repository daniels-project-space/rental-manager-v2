import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { countPlatformFallout } from "./platform_fallout";
import { dedupByLogicalRental } from "./reservations/predicates";

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
  const event = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
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
  const makeCtx = (source: Record<string, unknown>[], reads: { count: number; indexes: string[] } = { count: 0, indexes: [] }) => ({
    db: { query: () => ({ withIndex: (_: string, build: (q: unknown) => unknown) => {
      reads.indexes.push(_);
      const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
      const range = {
        eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return range; },
        gte(key: string, value: number) { predicates.push((row) => typeof row[key] === "number" && (row[key] as number) >= value); return range; },
        lt(key: string, value: number) { predicates.push((row) => typeof row[key] === "number" && (row[key] as number) < value); return range; },
      };
      build(range);
      const matching = () => source.filter((row) => predicates.every((test) => test(row)));
      const record = (result: Record<string, unknown>[]) => { reads.count += result.length; return result; };
      return { collect: async () => record(matching()), take: async (n: number) => record(matching().slice(0, n)) };
    } }) },
  }) as unknown as QueryCtx;
  const ctx = makeCtx(rows);

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

  it("expands identities before deduplication so a higher-valued nonfailure suppresses a failure", async () => {
    const source = [
      event("failed", { hygglo_order_id: "shared", obsolete_at: start + 10, net_to_owner_gbp: 100 }),
      event("cancelled", { hygglo_order_id: "shared", obsolete_at: start + 20, net_to_owner_gbp: 200, hygglo_system_signal: "renter_cancelled" }),
    ];
    expect((await loadMonthlyVerificationLosses(makeCtx(source), "2026-10", null)).total_count).toBe(0);
  });

  it("retains original event-date order for equal-valued duplicate signals", async () => {
    const source = [
      event("cancelled", { hygglo_order_id: "shared", obsolete_at: start + 10, net_to_owner_gbp: 100, hygglo_system_signal: "owner_denied" }),
      event("failed", { hygglo_order_id: "shared", obsolete_at: start + 20, net_to_owner_gbp: 100 }),
    ];
    expect((await loadMonthlyVerificationLosses(makeCtx(source), "2026-10", null)).total_count).toBe(0);
    source[1].obsolete_at = start + 5;
    expect((await loadMonthlyVerificationLosses(makeCtx(source), "2026-10", null)).total_count).toBe(1);
  });

  it("preserves all legacy signal and terminal variants and decisive-signal precedence", async () => {
    const source = [undefined, "none", "approved"].flatMap((signal, i) =>
      [true, false, undefined].flatMap((obsolete, j) => ["cancelled", "declined"].map((status, k) =>
        event(`legacy-${i}-${j}-${k}`, { obsolete_at: start + i * 100 + j * 10 + k,
          hygglo_system_signal: signal, is_obsolete: obsolete, status,
          hygglo_system_signal_text: "Renter did not pass our security checks", net_to_owner_gbp: 10 }))))
      .concat([
        event("decisive", { obsolete_at: start + 1000, hygglo_system_signal: "owner_denied", obsolete_reason: "verification_failed" }),
        event("recovered", { obsolete_at: start + 1001, hygglo_system_signal: "none", status: "confirmed", is_obsolete: false, order_step: "VERIFICATION_FAILED" }),
        event("legacy-renter", { obsolete_at: start + 1002, hygglo_system_signal: "none", obsolete_reason: "renter_cancelled", order_step: "CANCELED", hygglo_system_signal_text: "did not pass our security checks" }),
      ]);
    const result = await loadMonthlyVerificationLosses(makeCtx(source), "2026-10", null);
    expect(result.total_count).toBe(18);
    expect(result.failed_security_checks_lost_gbp).toBe(180);
  });

  it("does not conflate provider identities that share an import identity", async () => {
    const source = [
      event("import-only", { hygglo_order_id: undefined, v1_rental_id: "v1", obsolete_at: start + 1, net_to_owner_gbp: 10 }),
      event("provider", { hygglo_order_id: "h1", v1_rental_id: "v1", obsolete_at: start + 2, net_to_owner_gbp: 99, hygglo_system_signal: "owner_denied" }),
    ];
    expect((await loadMonthlyVerificationLosses(makeCtx(source), "2026-10", null)).failed_security_checks_lost_gbp).toBe(10);
  });

  it("falls back to exact date partitions for identity-less and unusually large duplicate groups", async () => {
    for (const source of [
      [event("ancient", { hygglo_order_id: undefined, obsolete_at: start, net_to_owner_gbp: 10 })],
      Array.from({ length: 9 }, (_, i) => event(`copy-${i}`, { hygglo_order_id: "same", obsolete_at: start + i, net_to_owner_gbp: i + 1 })),
    ]) {
      const reads = { count: 0, indexes: [] as string[] };
      const result = await loadMonthlyVerificationLosses(makeCtx(source, reads), "2026-10", null);
      expect(result.total_count).toBe(1);
      expect(reads.indexes.filter((index) => index === "by_fallout_dates")).toHaveLength(3);
    }
  });

  it("avoids reading unrelated decisive-signal history", async () => {
    const source = [event("failed", { obsolete_at: start, net_to_owner_gbp: 10 }),
      ...Array.from({ length: 500 }, (_, i) => event(`unrelated-${i}`, {
        obsolete_at: start + i + 1, hygglo_system_signal: "owner_denied", net_to_owner_gbp: 999,
      }))];
    const reads = { count: 0, indexes: [] as string[] };
    expect((await loadMonthlyVerificationLosses(makeCtx(source, reads), "2026-10", null)).total_count).toBe(1);
    expect(reads.count).toBe(2);
    expect(reads.indexes).not.toContain("by_fallout_dates");
  });

  it.runIf(!!process.env.RM_HEADLINE_SOURCE_SNAPSHOT)("matches the original reader on private production rows across months and accounts", async () => {
    const source = JSON.parse(fs.readFileSync(process.env.RM_HEADLINE_SOURCE_SNAPSHOT!, "utf8")).reservations;
    for (const month of ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]) {
      const [year, number] = month.split("-").map(Number);
      const lo = Date.UTC(year, number - 1, 1), hi = Date.UTC(year, number, 1);
      for (const account of [null, "leo", "diogo", "db_cinema", "dbcinema_web"]) {
        const dated = source.filter((r: any) => {
          const t = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
          return t >= lo && t < hi && (!account || r.account_slug === account) &&
            (r.is_obsolete === true || r.status === "cancelled" || r.status === "declined");
        }).sort((a: any, b: any) => {
          const group = (r: any) => r.obsolete_at !== undefined ? 0 : r.v1_updated_at !== undefined ? 1 : 2;
          const cmp = (x: any, y: any) => x === y ? 0 : x === undefined ? -1 : y === undefined ? 1 : x - y;
          return group(a) - group(b) || cmp(a.obsolete_at, b.obsolete_at) || cmp(a.v1_updated_at, b.v1_updated_at) || a._creationTime - b._creationTime;
        });
        const original = countPlatformFallout(dedupByLogicalRental(dated));
        const result = await loadMonthlyVerificationLosses(makeCtx(source), month, account);
        expect(result.failed_security_checks_count, `${month}/${account}`).toBe(original.failed_security_checks_count);
        expect(result.failed_security_checks_lost_gbp, `${month}/${account}`).toBe(original.failed_security_checks_lost_gbp);
      }
    }
  });
});
