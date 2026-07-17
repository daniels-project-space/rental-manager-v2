import { describe, expect, it } from "vitest";
import {
  filterByCurrentOrderPresence,
  isInCurrentOrderPresence,
  isOutstandingReturnState,
  isPlatformClosePending,
} from "./return_presence";

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

  it("keeps a completed return only while its Hygglo close is genuinely pending", () => {
    const pending = {
      status: "completed",
      order_step: "RETURNED",
      platform_close_pending: true,
    };
    expect(isPlatformClosePending(pending)).toBe(true);
    expect(isOutstandingReturnState(pending, "2026-07-17")).toBe(true);
    expect(
      isOutstandingReturnState({ ...pending, platform_closed_at: Date.now() }, "2026-07-17"),
    ).toBe(false);
    expect(
      isOutstandingReturnState({ ...pending, order_step: "REVIEWED" }, "2026-07-17"),
    ).toBe(false);
  });

  it("does not mistake an ordinary completed reservation for an outstanding return", () => {
    expect(
      isOutstandingReturnState(
        { status: "completed", order_step: "RETURNED", platform_close_pending: false },
        "2026-07-17",
      ),
    ).toBe(false);
  });

  it("requires exact current-feed membership for a completed pending close", () => {
    const row = { account_slug: "leo", hygglo_order_id: "still-current" };
    expect(
      isInCurrentOrderPresence(row, [{ account: "leo", orderIds: ["still-current"] }]),
    ).toBe(true);
    expect(isInCurrentOrderPresence(row, [])).toBe(false);
    expect(
      isInCurrentOrderPresence(row, [{ account: "leo", orderIds: ["different"] }]),
    ).toBe(false);
  });
});
