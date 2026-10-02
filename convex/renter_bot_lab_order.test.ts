import { describe, it, expect } from "vitest";
import { inclusiveDays, summarise } from "./renter_bot_lab_order";

/**
 * Day counting and totals for the simulated booking. Hygglo counts days
 * INCLUSIVELY, so an off-by-one here understates every quote the bot gives.
 */
describe("simulated booking maths", () => {
  it("counts a same-day rental as one day", () => {
    expect(inclusiveDays("2026-08-23", "2026-08-23")).toBe(1);
  });

  it("counts 23rd to 24th as two days, not one", () => {
    expect(inclusiveDays("2026-08-23", "2026-08-24")).toBe(2);
  });

  it("never returns less than a day for missing or reversed dates", () => {
    expect(inclusiveDays(undefined, undefined)).toBe(1);
    expect(inclusiveDays("2026-08-24", "2026-08-23")).toBe(1);
  });

  it("multiplies each line by qty AND days", () => {
    const s = summarise(
      [
        { name: "BMPCC 6K Pro", qty: 1, daily_price_gbp: 35, pricing_basis: "listing", origin: "seed" },
        { name: "Blazar Remus 100mm", qty: 1, daily_price_gbp: 25, pricing_basis: "listing", origin: "added" },
        { name: "PL to EF mount", qty: 2, daily_price_gbp: 8, pricing_basis: "listing", origin: "added" },
      ],
      "2026-08-23",
      "2026-08-24",
    );
    expect(s.days).toBe(2);
    expect(s.lines.map((l) => l.line_total_gbp)).toEqual([70, 50, 32]);
    expect(s.total_gbp).toBe(152);
  });

  it("refuses a total when any line has no price, rather than inventing one", () => {
    const s = summarise(
      [
        { name: "BMPCC 6K Pro", qty: 1, daily_price_gbp: 35, origin: "seed" },
        { name: "Mystery rig", qty: 1, origin: "added" },
      ],
      "2026-08-23",
      "2026-08-23",
    );
    expect(s.total_gbp).toBeNull();
    expect(s.unpriced).toEqual(["Mystery rig"]);
  });
  it("keeps a base-only catalogue price unknown when dates extend beyond one day", () => {
    const lines = [{name:"PL to RF mount",qty:2,daily_price_gbp:8,pricing_basis:"catalog" as const}];
    expect(summarise(lines,"2026-10-20","2026-10-20").total_gbp).toBe(16);
    const extended = summarise(lines,"2026-10-20","2026-10-21");
    expect(extended.total_gbp).toBeNull();
    expect(extended.unpriced).toEqual(["PL to RF mount"]);
    expect(extended.lines[0]).toMatchObject({daily_price_gbp:8,effective_rate_gbp:null,line_total_gbp:null});
    expect(summarise(lines,"2026-10-20","2026-10-20").total_gbp).toBe(16);
  });
  it("cannot treat an old daily-only line or catalogue-attached tiers as verified duration pricing", () => {
    const legacy={name:"PL to RF mount",qty:1,daily_price_gbp:8};
    expect(summarise([legacy],"2026-10-20","2026-10-21").total_gbp).toBeNull();
    expect(summarise([{...legacy,pricing_basis:"catalog",price_tiers:[{days:1,pricePerDay:8}]}],"2026-10-20","2026-10-21").total_gbp).toBeNull();
    expect(summarise([{...legacy,product_id:1172765}],"2026-10-20","2026-10-21").total_gbp).toBe(16);
  });
});
