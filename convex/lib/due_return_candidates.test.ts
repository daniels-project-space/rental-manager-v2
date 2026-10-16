import { describe, expect, it } from "vitest";
import { loadConfirmedReturnCandidates } from "./due_return_candidates";

describe("indexed due-return candidate loading", () => {
  it("reads only delivered, returned, and overdue legacy rows for the requested account", async () => {
    const rows = [
      { _id: "delivered", _creationTime: 1, account_slug: "dbcinema", status: "confirmed", order_step: "DELIVERED", end_date: "2026-10-10" },
      { _id: "returned", _creationTime: 2, account_slug: "dbcinema", status: "confirmed", order_step: "RETURNED", end_date: "2026-10-10" },
      // Missing dates stay in the physical-out candidate set, as in the old scan.
      { _id: "no-date", _creationTime: 3, account_slug: "dbcinema", status: "confirmed", order_step: "DELIVERED" },
      { _id: "legacy-due", _creationTime: 4, account_slug: "dbcinema", status: "confirmed", end_date: "2026-10-15" },
      { _id: "legacy-future", _creationTime: 5, account_slug: "dbcinema", status: "confirmed", end_date: "2026-10-20" },
      { _id: "reviewed", _creationTime: 6, account_slug: "dbcinema", status: "confirmed", order_step: "REVIEWED", end_date: "2026-10-10" },
      { _id: "cancelled", _creationTime: 7, account_slug: "dbcinema", status: "cancelled", order_step: "DELIVERED", end_date: "2026-10-10" },
      { _id: "other-account", _creationTime: 8, account_slug: "leo", status: "confirmed", order_step: "RETURNED", end_date: "2026-10-10" },
    ];
    const reads: Array<{ index: string; constraints: Array<[string, string, unknown]> }> = [];
    const db: any = {
      query: (table: string) => {
        if (table !== "reservations") throw Error(`Unexpected table ${table}`);
        let constraints: Array<[string, string, unknown]> = [];
        const query: any = {
          withIndex: (index: string, select: (builder: any) => void) => {
            constraints = [];
            const builder: any = {
              eq: (field: string, value: unknown) => { constraints.push(["eq", field, value]); return builder; },
              lte: (field: string, value: unknown) => { constraints.push(["lte", field, value]); return builder; },
            };
            select(builder);
            reads.push({ index, constraints: [...constraints] });
            return query;
          },
          collect: async () => rows.filter(row => constraints.every(([op, field, value]) =>
            op === "eq" ? (row as any)[field] === value :
              (row as any)[field] !== undefined && String((row as any)[field]) <= String(value),
          )),
        };
        return query;
      },
    };

    const result = await loadConfirmedReturnCandidates({ db } as any, "dbcinema", "2026-10-16");
    expect(result.map(row => row._id)).toEqual(["delivered", "returned", "no-date", "legacy-due"]);
    expect(reads.map(read => read.index)).toEqual([
      "by_status_order_step_end_date",
      "by_status_order_step_end_date",
      "by_status_order_step_end_date",
    ]);
    expect(reads[2].constraints).toEqual([
      ["eq", "status", "confirmed"],
      ["eq", "order_step", undefined],
      ["lte", "end_date", "2026-10-16"],
    ]);
  });
});
