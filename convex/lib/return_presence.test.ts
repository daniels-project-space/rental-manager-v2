import { describe, expect, it } from "vitest";
import { filterByCurrentOrderPresence } from "./return_presence";

describe("filterByCurrentOrderPresence", () => {
  const rows = [
    { account_slug: "leo", hygglo_order_id: "still-current", last_polled_at: 1 },
    { account_slug: "leo", hygglo_order_id: "silently-completed", last_polled_at: 2 },
    { account_slug: "web", hygglo_order_id: "web-import", last_polled_at: 3 },
    { account_slug: "leo", last_polled_at: 4 },
  ];

  it("keeps an unchanged current order regardless of its old poll timestamp", () => {
    expect(
      filterByCurrentOrderPresence(rows, [
        { account: "leo", orderIds: ["still-current"] },
      ]),
    ).toEqual([rows[0], rows[2], rows[3]]);
  });

  it("preserves all candidates until an account has a complete snapshot", () => {
    expect(filterByCurrentOrderPresence(rows, [])).toEqual(rows);
  });
});
