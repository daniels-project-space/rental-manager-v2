import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { check_location } from "./renter_bot_tools";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("prices the actual distance before rounding it for display", async () => {
  vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
  const originLat = 51;
  let distanceKm = 30.01;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({
    result: { latitude: url.includes("WC2N5DB") ? originLat : originLat + (distanceKm / 6371) * 180 / Math.PI, longitude: 0 },
  }))));
  const ctx = { runQuery: vi.fn(async (ref: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(ref)) {
      case "renter_bot_tools:__service_deliverySpecs":
        return { ok: true, account_slug: "dbcinema", basket_updated_at: 1, inventory_updated_at: 2,
          items: [{ spec: { kind: "camera", weight_kg: 2, size_score: 3 }, qty: 1 }] };
      case "replyInbox:getThreadContext":
        return { messages: [{ role: "renter", content: "How much is delivery to SW1A 1AA?" }] };
      case "settings:__service_listAccountHubs":
        return [{ slug: "dbcinema", hub_postcode: "WC2N 5DB", hub_label: "Central London" }];
      case "settings:__service_get": return { hub_max_km: 30, hub_heavy_max_km: 30 };
      default: throw new Error(`Unexpected query: ${getFunctionName(ref)}`);
    }
  }) };
  const result = await (check_location as any)._handler(ctx, { thread_id: "__probe__boundary", renter_postcode: "SW1A 1AA" });
  // 30.01 km is outside the 30 km range even though the display rounds to 30.
  expect(result).toMatchObject({ ok: true, distance_km: 30, within_delivery_range: false });
  distanceKm = 3.01;
  const inRange = await (check_location as any)._handler(ctx, { thread_id: "__probe__boundary", renter_postcode: "SW1A 1AA" });
  expect(inRange).toMatchObject({ ok: true, distance_km: 3, within_delivery_range: true, delivery_pricing_status: "needs_checkout_verification" });
  expect(inRange).not.toHaveProperty("delivery_fee_gbp");
  expect(inRange.note).not.toMatch(/£/);
});

it("returns only the exact checkout receipt for the current Lab basket and renter postcode", async () => {
  vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
  const timestamp = Date.parse("2026-11-26T12:00:00Z");
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, request: RequestInit) => {
    const body = JSON.parse(String(request.body)); calls.push(body.path);
    const value = body.path === "catalog:discovery"
      ? {page:[{slug:"blackmagic-kit-1103089"}],isDone:true}
      : body.path === "catalog:getListingBySlug"
        ? {_id:"website-listing",slug:"blackmagic-kit-1103089",bookable:true,marketingOnly:false}
        : {ok:true,fee:46,km:1.3,vehicle:"car",groups:[{start:timestamp,end:timestamp,fee:46}]};
    return new Response(JSON.stringify({status:"success",value}));
  }));
  const ctx = {runQuery:vi.fn(async (ref:Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(ref)) {
      case "renter_bot_tools:__service_deliverySpecs": return {ok:true,account_slug:"dbcinema",basket_updated_at:1,inventory_updated_at:2,
        items:[],checkout:{startDate:"2026-11-26",endDate:"2026-11-26",items:[{productId:1103089,qty:1}]}};
      case "replyInbox:getThreadContext": return {messages:[{role:"renter",content:"Delivery to SW1A 1AA?"}]};
      default: throw Error("Unexpected query");
    }
  })};
  expect(await (check_location as any)._handler(ctx,{thread_id:"__probe__delivery",renter_postcode:"SW1A 1AA"}))
    .toMatchObject({ok:true,delivery_fee_gbp:46,delivery_round_trip:true,quote_source:"db_cinema_weighted_checkout_v1",basket_updated_at:1,inventory_updated_at:2});
  expect(calls).toEqual(["catalog:discovery","catalog:getListingBySlug","delivery:quote"]);
  calls.length=0;
  expect(await (check_location as any)._handler(ctx,{thread_id:"__probe__delivery",renter_postcode:"E1 6AN"})).toMatchObject({ok:false});
  expect(calls).toEqual([]);
});
