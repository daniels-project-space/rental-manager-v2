import { describe, expect, it } from "vitest";
import { ACCOUNT_ALL, ACCOUNTS } from "./constants";
import {
  applyEarningsContributionChanges,
  computeEarningsByPeriod,
  getEarningsContribution,
  type EarningsContributionChange,
} from "./earnings_by_period";

const GENERATED_AT = Date.UTC(2026, 9, 16, 12);

function row(status: string, fields: Record<string, unknown> = {}) {
  return {
    status,
    account_slug: "leo",
    start_date: "2026-10-10",
    gross_paid_gbp: 100,
    ...fields,
  };
}

describe("incremental earnings buckets", () => {
  it("matches a full rebuild after inserts, booking edits, account moves and cancellation", () => {
    const before = [
      row("confirmed", { net_to_owner_gbp: 64 }),
      row("confirmed", { account_slug: "dbcinema", start_date: "2026-09-30", gross_paid_gbp: 50 }),
    ];
    const after = [
      row("confirmed", { net_to_owner_gbp: 64 }),
      row("cancelled", { account_slug: "dbcinema", start_date: "2026-09-30", gross_paid_gbp: 50 }),
      row("confirmed", { account_slug: "diogo", start_date: "2026-10-12", net_to_owner_gbp: 120 }),
    ];
    const changes: EarningsContributionChange[] = [
      { before: null, after: getEarningsContribution(after[2]) },
      { before: getEarningsContribution(before[1]), after: getEarningsContribution(after[1]) },
    ];
    const initial = computeEarningsByPeriod({ reservations: before, generatedAt: GENERATED_AT });
    const updated = applyEarningsContributionChanges(initial, changes, GENERATED_AT + 1);

    expect(updated).not.toBeNull();
    const fullRebuild = computeEarningsByPeriod({ reservations: after, generatedAt: GENERATED_AT + 1 });
    const withoutGenerationTime = (rows: typeof fullRebuild) =>
      rows.map(({ account, granularity, buckets }) => ({ account, granularity, buckets }));
    expect(withoutGenerationTime(updated!)).toEqual(withoutGenerationTime(fullRebuild));
    expect(updated!.find((entry) => entry.account === "dbcinema_web")?.generatedAt).toBe(GENERATED_AT);
  });

  it("leaves the snapshot unchanged for contributions outside its date window", () => {
    const initial = computeEarningsByPeriod({ reservations: [], generatedAt: GENERATED_AT });
    const change: EarningsContributionChange = {
      before: null,
      after: getEarningsContribution(row("confirmed", { start_date: "2027-01-01" })),
    };

    expect(applyEarningsContributionChanges(initial, [change], GENERATED_AT + 1)).toEqual(initial);
  });

  it("requests a full rebuild if a removal would make a bucket negative", () => {
    const initial = computeEarningsByPeriod({ reservations: [], generatedAt: GENERATED_AT });
    const change: EarningsContributionChange = {
      before: getEarningsContribution(row("confirmed", { net_to_owner_gbp: 64 })),
      after: null,
    };

    expect(applyEarningsContributionChanges(initial, [change], GENERATED_AT + 1)).toBeNull();
  });

  it("requires the full bounded account/granularity snapshot before applying deltas", () => {
    const complete = computeEarningsByPeriod({ reservations: [], generatedAt: GENERATED_AT });
    const incomplete = complete.filter((entry) =>
      !(entry.account === ACCOUNTS[0] && entry.granularity === "weekly"),
    );
    const change: EarningsContributionChange = {
      before: null,
      after: getEarningsContribution(row("confirmed")),
    };

    expect(incomplete.length).toBe((ACCOUNTS.length + 1) * 2 - 1);
    expect(applyEarningsContributionChanges(incomplete, [change], GENERATED_AT + 1)).toBeNull();
    expect(complete.some((entry) => entry.account === ACCOUNT_ALL)).toBe(true);
  });
});
