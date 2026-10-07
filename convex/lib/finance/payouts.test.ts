import { describe, expect, it } from "vitest";
import { allocate, balances, pence } from "./payouts";
import { invoiceAmounts } from "./invoices";
describe("partner allocations", () => {
  it("does not create debt from unequal withdrawals within allowances", () => {
    const b = balances(allocate(200000, 5000), [
      { kind: "withdrawal", person: "Leo", amount: 80000 },
    ]);
    expect(b.Daniel).toEqual({ business: 100000, owed: 0, excess: 0 });
    expect(b.Leo.business).toBe(20000);
  });
  it("separates business allowance and £800 debt after Leo exceeds his share", () => {
    const b = balances(allocate(200000, 5000), [
      { kind: "withdrawal", person: "Leo", amount: 180000 },
    ]);
    expect(b.Daniel).toEqual({ business: 20000, owed: 80000, excess: 0 });
    expect(b.Leo.excess).toBe(80000);
    expect(b.cash).toBe(20000);
  });
  it("clears debt on direct repayment without changing business cash", () => {
    const b = balances(allocate(200000, 5000), [
      { kind: "withdrawal", person: "Leo", amount: 180000 },
      { kind: "settlement", person: "Leo", amount: 80000 },
    ]);
    expect(b.Daniel).toEqual({ business: 20000, owed: 0, excess: 0 });
    expect(b.Leo.excess).toBe(0);
    expect(b.cash).toBe(20000);
  });
  it("carries negative shares and conserves odd pennies", () => {
    for (const value of [1, 101, -101, 200001]) {
      const a = allocate(value, 3333);
      expect(a.Daniel + a.Leo).toBe(value);
    }
    const b = balances(allocate(-10000, 5000), []);
    expect(b.Daniel.owed).toBe(0);
    expect(b.Leo.owed).toBe(0);
    expect(b.cash).toBe(-10000);
  });
  it("business return reverses a withdrawal", () => {
    expect(
      balances(allocate(200000, 5000), [
        { kind: "withdrawal", person: "Leo", amount: 180000 },
        { kind: "withdrawal", person: "Leo", amount: -80000 },
      ]).Leo.excess,
    ).toBe(0);
  });
  it("rejects invalid inputs", () => {
    expect(() => allocate(100, 10001)).toThrow();
    expect(() => pence(NaN)).toThrow();
  });
});
describe("invoice amounts", () => {
  it("reads the verified Hygglo invoice layout and keeps undisclosed renter fees unknown", () => {
    expect(
      invoiceAmounts(
        "Hygglo Ltd\nOrder value incl. VAT 60.00\nCommission incl. VAT -12.00\nNet payout 48.00",
      ),
    ).toEqual({
      amounts: {
        revenue: 6000,
        lender_fee: 1200,
        payout: 4800,
        currency: "GBP",
      },
      verified: true,
    });
  });
  it("flags inconsistent totals and conflicting repeated amounts", () => {
    expect(
      invoiceAmounts(
        "GBP\nOrder value incl. VAT 60.00\nCommission incl. VAT -12.00\nNet payout 49.00",
      ).verified,
    ).toBe(false);
    expect(
      invoiceAmounts(
        "GBP\nOrder value incl. VAT 60.00\nOrder value incl. VAT 70.00",
      ).amounts.revenue,
    ).toBeUndefined();
  });
});
