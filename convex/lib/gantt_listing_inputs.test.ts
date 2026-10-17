import { describe, it, expect } from "vitest";
import type { QueryCtx } from "../_generated/server";
import { ganttListingKeys, loadGanttListingInputs, useSourceGanttInputs, ganttInputReport } from "./gantt_listing_inputs";
import { buildProductIndexMap, reservationItemUnits } from "./reservations/itemUnits";
import { canonicalListingAllocation } from "./canonical_listing_allocation";

function fixture() {
  const tables: Record<string, any[]> = {
    items: [{ _id: "camera", _creationTime: 1, name_canonical: "Camera", kind: "camera", qty: 3, image_url: "https://example.invalid/camera.jpg", aliases: ["body"] }],
    hygglo_product_index: [{ _id: "i-old", _creationTime: 1, account_slug: "leo", product_id: 7, item_id: "old" }, { _id: "i-new", _creationTime: 4, account_slug: "leo", product_id: 7, item_id: "camera" }, { _id: "i-other", _creationTime: 3, account_slug: "other", product_id: 7, item_id: "foreign" }],
    listing_resolution_override: [{ _id: "first", _creationTime: 2, account_slug: "leo", product_id: 7, components: [] }, { _id: "later", _creationTime: 5, account_slug: "leo", product_id: 7, components: [{ item_id: "camera", qty: 2 }] }, { _id: "foreign", _creationTime: 3, account_slug: "other", product_id: 7, components: [{ item_id: "foreign", qty: 1 }] }],
  };
  const reads: Array<{ table: string; index?: string; filters: unknown[] }> = [];
  const db: any = { query(table: string) {
    let index: string | undefined; const filters: Array<[string, unknown]> = [];
    const q: any = { withIndex(name: string, build: (q: any) => unknown) { index = name; const r: any = { eq(k: string, v: unknown) { filters.push([k, v]); return r; } }; build(r); return q; }, async collect() {
      reads.push({ table, index, filters: structuredClone(filters) });
      return structuredClone(tables[table].filter(row => filters.every(([k, v]) => Object.is(row[k], v))).slice().sort((a, b) => a._creationTime - b._creationTime));
    } }; return q;
  } };
  return { tables, reads, ctx: () => ({ db }) as QueryCtx };
}
describe("bounded Gantt listing inputs", () => {
  it("deduplicates keys in reservation order and includes frozen website image mappings", () => {
    expect(ganttListingKeys([{ account_slug: "leo", hygglo_items: [{ product_id: 7 }, { product_id: 7 }] }, { account_slug: "dbcinema_web", site_item_windows: [], hygglo_items: [{ product_id: 8 }] }])).toEqual([{ account: "leo", productId: 7 }, { account: "dbcinema_web", productId: 8 }]);
  });
  it("retains all duplicate rows, source first/last winners and explicit empty exclusions", async () => {
    const f = fixture(), ctx = f.ctx(); const rows = await loadGanttListingInputs(ctx, f.tables.items as never, [{ account_slug: "leo", hygglo_items: [{ product_id: 7 }] }]);
    expect(rows.productIndexRows.map(r => r._id)).toEqual(["i-old", "i-new"]); expect(buildProductIndexMap(rows.productIndexRows).get("leo#7")).toBe("camera");
    expect(rows.overrideRows.map(r => r._id)).toEqual(["first", "later"]);
    const allocation = canonicalListingAllocation(rows.inventory, rows.overrideRows, [], []);
    expect(allocation.get("leo#7")).toEqual([]); expect(reservationItemUnits({ account_slug: "leo", hygglo_items: [{ product_id: 7 }] }, buildProductIndexMap(rows.productIndexRows), allocation, rows.inventory).size).toBe(0);
    expect(f.reads).toHaveLength(2); expect(f.reads.every(r => r.index === "by_account_product")).toBe(true);
  });
  it("preserves every inventory field and independent mutable values", async () => {
    const f = fixture(); const rows = await loadGanttListingInputs(f.ctx(), f.tables.items as never, []);
    expect(rows.inventory).toEqual(f.tables.items); rows.inventory[0].aliases!.push("local change"); expect(f.tables.items[0].aliases).toEqual(["body"]); expect(f.reads).toEqual([]);
  });
  it.each([NaN, Infinity, -Infinity, -0, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])("uses full sources for legacy product identity %s", async product_id => {
    const f = fixture(), ctx = f.ctx(); const rows = await loadGanttListingInputs(ctx, f.tables.items as never, [{ account_slug: "leo", hygglo_items: [{ product_id }] }]);
    expect(rows.productIndexRows).toEqual(f.tables.hygglo_product_index.slice().sort((a, b) => a._creationTime - b._creationTime)); expect(f.reads.every(r => !r.index)).toBe(true); expect(ganttInputReport(ctx)?.mode).toBe("full");
  });
  it("retains frozen website mapping and inventory-image inputs independently of frozen quantities", async () => {
    const f = fixture(); f.tables.listing_resolution_override.push({ _id: "website", _creationTime: 8, account_slug: "dbcinema_web", product_id: 8, components: [{ item_id: "camera", qty: 2 }] });
    const rental = { account_slug: "dbcinema_web", site_item_windows: [{ item_id: "camera", qty: 1, start: 0, end: 1000 }], hygglo_items: [{ product_id: 8 }] };
    const data = await loadGanttListingInputs(f.ctx(), f.tables.items as never, [rental]); const map = canonicalListingAllocation(data.inventory, data.overrideRows, [], []);
    expect(map.get("dbcinema_web#8")).toEqual([{ item_id: "camera", qty: 2 }]);
    expect(data.inventory.find(i => i._id === map.get("dbcinema_web#8")![0].item_id)?.image_url).toBe("https://example.invalid/camera.jpg");
    expect(reservationItemUnits(rental, buildProductIndexMap(data.productIndexRows), map, data.inventory).get("camera")).toBe(1);
  });
  it.each([undefined, ""])("retains full maps for missing/empty account %s", async account_slug => {
    const f = fixture(), ctx = f.ctx(); const rows = await loadGanttListingInputs(ctx, f.tables.items as never, [{ account_slug, hygglo_items: [{ product_id: 7 }] }]); expect(rows.overrideRows).toHaveLength(3); expect(ganttInputReport(ctx)?.mode).toBe("full");
  });
  it("does not clip larger listing windows", async () => {
    const f = fixture(), ctx = f.ctx(); const rentals = [{ account_slug: "leo", hygglo_items: Array.from({ length: 129 }, (_, product_id) => ({ product_id })) }]; expect(ganttListingKeys(rentals)).toBeNull(); expect((await loadGanttListingInputs(ctx, f.tables.items as never, rentals)).overrideRows).toHaveLength(3); expect(f.reads.every(r => !r.index)).toBe(true);
  });
  it("retains the original source tie breaker for ambiguous index rows", async () => {
    const f = fixture(); f.tables.hygglo_product_index[1]._creationTime = 1; const ctx = f.ctx(); await loadGanttListingInputs(ctx, f.tables.items as never, [{ account_slug: "leo", hygglo_items: [{ product_id: 7 }] }]); expect(ganttInputReport(ctx)).toMatchObject({ mode: "full", reason: "source creation-time tie" }); expect(f.reads.some(r => r.table === "hygglo_product_index" && !r.index)).toBe(true);
  });
  it("keeps legacy qualification independent with the original three complete reads", async () => {
    const f = fixture(), ctx = f.ctx(); useSourceGanttInputs(ctx); const rows = await loadGanttListingInputs(ctx, f.tables.items as never, [{ account_slug: "leo", hygglo_items: [{ product_id: 7 }] }]); expect(rows.overrideRows).toHaveLength(3); expect(f.reads.map(r => r.table).sort()).toEqual(["hygglo_product_index", "items", "listing_resolution_override"]); expect(f.reads.every(r => !r.index)).toBe(true);
  });
});
