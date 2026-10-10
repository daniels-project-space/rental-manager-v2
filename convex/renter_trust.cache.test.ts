import { describe, it, expect, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { applyTrust } from "./renter_trust";
async function update(reviews: unknown[], old: any[] = []) {
  const patch = vi.fn(),
    insert = vi.fn(async () => "fixture-new"),
    remove = vi.fn();
  const query = { withIndex: () => query, collect: async () => old };
  await (applyTrust as any)._handler(
    { db: { patch, insert, delete: remove, query: () => query } },
    { renter_id: "fixture-renter", reviews },
  );
  return { patch, insert, remove };
}
describe("review history survives partial provider reads", () => {
  it("advances a relative date when the provider refreshes it", async () => {
    const db = await update(
      [{ rating: 5, text: "Good", author: "A", created_at: "2 months ago" }],
      [
        {
          _id: "old",
          hygglo_review_id: 1,
          rating: 5,
          text: "Good",
          author: "A",
          created_at: "2 weeks ago",
        },
      ],
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.patch).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({ created_at: "2 months ago" }),
    );
  });
  it("never deletes cached history on an empty response", async () => {
    const db = await update(
      [],
      [{ _id: "old", hygglo_review_id: 1, text: "Good" }],
    );
    expect(db.remove).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("adds new reviews without removing existing reviews", async () => {
    const db = await update(
      [{ rating: 5, text: "New", author: "B" }],
      [
        {
          _id: "old",
          hygglo_review_id: 1,
          rating: 4,
          text: "Old",
          author: "A",
        },
      ],
    );
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.remove).not.toHaveBeenCalled();
  });
  it("deduplicates repeated reviews and preserves a precise date", async () => {
    const db = await update(
      [{ rating: 5, text: "Good", author: "A", created_at: "2 weeks ago" }],
      [
        {
          _id: "old",
          hygglo_review_id: 1,
          rating: 5,
          text: "Good",
          author: "A",
          created_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.patch).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({ created_at: "2026-05-01T00:00:00.000Z" }),
    );
  });
  it("deduplicates repeated entries in a single provider response", async () => {
    const db = await update([
      { rating: 5, text: "Good" },
      { rating: 5, text: "Good" },
    ]);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
