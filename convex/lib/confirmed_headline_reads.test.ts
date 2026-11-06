import { describe, expect, it, vi } from "vitest";
import {
  MAX_RENTAL_HEADLINE_WINDOW_ROWS,
  mergeConfirmedHeadlineWindows,
  takeRentalHeadlineWindow,
} from "./confirmed_headline_reads";

describe("bounded live rental headline reads", () => {
  it("uses a fixed indexed-read cap and preserves complete results below it", async () => {
    const rows = [{ id: "r1" }, { id: "r2" }];
    const take = vi.fn(async (limit: number) => rows.slice(0, limit));
    await expect(takeRentalHeadlineWindow({ take }, "start_date")).resolves.toEqual(rows);
    expect(take).toHaveBeenCalledWith(MAX_RENTAL_HEADLINE_WINDOW_ROWS + 1);
  });

  it("fails visibly if a date window would otherwise be silently truncated", async () => {
    const take = vi.fn(async (limit: number) => Array.from({ length: limit }, (_, id) => ({ id })));
    await expect(takeRentalHeadlineWindow({ take }, "pickup_date"))
      .rejects.toThrow("Live rental headline window exceeded");
    expect(take).toHaveBeenCalledWith(MAX_RENTAL_HEADLINE_WINDOW_ROWS + 1);
  });

  it("deduplicates overlapping indexed date windows by reservation id", () => {
    expect(mergeConfirmedHeadlineWindows([
      [{ _id: "a", value: 1 }, { _id: "b", value: 2 }],
      [{ _id: "b", value: 3 }, { _id: "c", value: 4 }],
    ])).toEqual([
      { _id: "a", value: 1 }, { _id: "b", value: 3 }, { _id: "c", value: 4 },
    ]);
  });
});
