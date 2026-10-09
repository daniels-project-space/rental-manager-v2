import { afterEach, describe, expect, it, vi } from "vitest";
import { getClosestAvailableDates } from "./vacation";

const request = { requested_start: "2026-10-20", requested_end: "2026-10-21" };
function database(extra: Record<string, any[]> = {}) {
  const data: Record<string, any[]> = {
    vacation_periods: [{ is_active: true, start_date: "2026-10-20", end_date: "2026-10-21" }],
    items: [{ _id: "camera", name_canonical: "Owned camera", status: "active", qty: 3 }],
    ...extra,
  };
  const reads: string[] = [];
  const ctx = { db: { query: (table: string) => {
    reads.push(table);
    const filters: Array<(r: any) => boolean> = [];
    const range: any = { eq: (field: string, value: unknown) => { filters.push(r => r[field] === value); return range; } };
    const q: any = { withIndex: (_name: string, apply: any) => { apply(range); return q; }, collect: async () => (data[table] ?? []).filter(r => filters.every(f => f(r))) };
    return q;
  } } };
  return { ctx, reads };
}
const invoke = (ctx: any, args: any = request) => (getClosestAvailableDates as any)._handler(ctx, args);
const reservation = (status = "confirmed", qty = 1) => ({ _id: "r1", status, account_slug: "leo", hygglo_order_id: "order1", start_date: "2026-10-18", end_date: "2026-10-19", expanded_items: [{ item_id: "camera", qty }] });
afterEach(() => vi.useRealTimers());

describe("vacation candidates use the renter stock source", () => {
  function setup(extra: Record<string, any[]> = {}) {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    return database(extra);
  }
  it("does not let an unrelated rental close a calendar window", async () => {
    const {ctx, reads} = setup({ reservations: [reservation()] });
    const result = await invoke(ctx);
    expect(result.before).toEqual({start:"2026-10-18",end:"2026-10-19"});
    expect(result.after).toEqual({start:"2026-10-22",end:"2026-10-23"});
    expect(result.alternative_stock_scope).toBe("not_checked");
    expect(result.availability_guidance).toContain("exact complete listing/basket");
    expect(reads).toEqual(["vacation_periods"]);
  });
  it("allows remaining physical units and reads one snapshot for all candidates", async () => {
    const {ctx, reads} = setup({ reservations: [reservation()] });
    const result = await invoke(ctx, {...request,item_id:"camera",requested_qty:2});
    expect(result.before).toEqual({start:"2026-10-18",end:"2026-10-19"});
    expect(result.alternative_stock_scope).toBe("physical_item");
    expect(reads.filter(t=>t==="items")).toHaveLength(1);
    expect(reads.filter(t=>t==="reservations")).toHaveLength(3); // confirmed and ongoing
  });
  it("keeps fully occupied units out of alternatives", async () => {
    const {ctx} = setup({ reservations: [reservation("confirmed",3)] });
    expect((await invoke(ctx,{...request,item_id:"camera"})).before).toEqual({start:"2026-10-16",end:"2026-10-17"});
  });
  it("uses ongoing rental return behavior", async () => {
    const {ctx} = setup({ reservations: [reservation("ongoing",3)] });
    expect((await invoke(ctx,{...request,item_id:"camera"})).before).toEqual({start:"2026-10-16",end:"2026-10-17"});
  });
  it.each(["marketing", "inactive", "missing"])("never suggests %s gear", async kind => {
    const {ctx} = setup({ items: kind==="missing"?[]:[{_id:"camera",name_canonical:"Owned camera",qty:3,status:kind==="inactive"?"inactive":"active",is_marketing_only:kind==="marketing"}] });
    const result = await invoke(ctx,{...request,item_id:"camera"});
    expect(result.before).toBeUndefined(); expect(result.after).toBeUndefined();
  });
  it("honors repair holds", async () => {
    const {ctx} = setup({ insurance_claims:[{stage:"in_for_repair",repair_item_ids:["camera","camera","camera"]}] });
    const result=await invoke(ctx,{...request,item_id:"camera"});
    expect(result.before).toBeUndefined();expect(result.after).toBeUndefined();
  });
  it("skips blacked-out windows", async () => {
    const {ctx}=setup({owner_unavailability:[{item_id:"camera",start_date:"2026-10-18",end_date:"2026-10-19"}]});
    expect((await invoke(ctx,{...request,item_id:"camera"})).before).toEqual({start:"2026-10-16",end:"2026-10-17"});
  });
  it("never suggests past windows for an old active vacation", async () => {
    const {ctx}=setup({vacation_periods:[{is_active:true,start_date:"2026-10-01",end_date:"2026-10-02"}]});
    const result=await invoke(ctx,{requested_start:"2026-10-01",requested_end:"2026-10-02"});
    expect(result.before).toBeUndefined();expect(result.after).toEqual({start:"2026-10-05",end:"2026-10-06"});
  });
  it.each([
    {...request,requested_start:"2026-02-30"}, {...request,requested_end:"2026-10-19"},
    {...request,requested_end:"2028-10-21"}, {...request,requested_qty:0}, {...request,requested_qty:1.5},
  ])("rejects malformed requests before reporting an open calendar", async args => {
    const {ctx,reads}=setup(); await expect(invoke(ctx,args)).rejects.toThrow("valid ordered ISO dates"); expect(reads).toEqual([]);
  });
  it("does not claim a stock check when the requested dates avoid vacation", async () => {
    const {ctx,reads}=setup();const result=await invoke(ctx,{...request,requested_start:"2026-10-22",requested_end:"2026-10-23",item_id:"camera"});
    expect(result.inVacation).toBe(false);expect(result.alternative_stock_scope).toBe("not_checked");expect(reads).toEqual(["vacation_periods"]);
  });
});
