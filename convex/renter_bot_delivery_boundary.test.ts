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
