import { describe, expect, it } from "vitest";
import { computePriceRecommendations } from "./items";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const reservation = (id: string, account_slug: string, status = "confirmed") => ({
  _id: id, _creationTime: now, account_slug, status,
  start_date: "2026-10-15",
  resolved_items: [{ item_id: `item-${account_slug}`, item_name_canonical: "Camera body", qty: 1 }],
}) as any;

describe("account-scoped live price recommendations", () => {
  it("tracks real recent demand separately for same-name pricing rows across accounts", () => {
    const pricing = [
      { _id: "price-leo", item_id: "item-leo", item_name_canonical: "Camera body", account_id: "account-leo", daily_price_min: 100, daily_price_max: 150, is_bundle: false, created_at: 1 },
      { _id: "price-daniel", item_id: "item-daniel", item_name_canonical: "Camera body", account_id: "account-daniel", daily_price_min: 200, daily_price_max: 250, is_bundle: false, created_at: 2 },
    ] as any;
    const input = {
      pricing,
      reservations: [reservation("leo-1", "leo"), reservation("leo-2", "leo"), reservation("leo-3", "leo"), reservation("daniel-1", "daniel"), reservation("cancelled", "leo", "cancelled")],
      accountSlugById: new Map([["account-leo", "leo"], ["account-daniel", "daniel"]]),
    } as any;

    const all = computePriceRecommendations(input, null, now);
    expect(all.map((row: any) => [row.pricingRowId, row.accountSlug, row.demandCount, row.suggestedRate])).toEqual([
      ["price-leo", "leo", 3, 115],
      ["price-daniel", "daniel", 1, 180],
    ]);
    expect(computePriceRecommendations(input, "leo", now).map((row: any) => row.pricingRowId)).toEqual(["price-leo"]);

    const changed = { ...input, reservations: input.reservations.filter((r: any) => r._id !== "leo-3") };
    expect(computePriceRecommendations(changed, "leo", now)).toEqual([]);
  });
});
