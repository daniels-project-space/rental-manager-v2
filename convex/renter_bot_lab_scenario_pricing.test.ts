import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { preparedListingPrice } from "./lib/renter_bot_lab_listing_snapshot";
import { summarise, seed } from "./renter_bot_lab_order";
import { startLiveSession } from "./renter_bot_lab_actions";
import { verificationFailureReply } from "./lib/verification_failure";
import { renterBotLabScenario } from "./lib/renter_bot_lab_scenarios";

const now = 1794480000000;
const product = {
  accountSlug: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf",
  isPublished: true, isMarketingOnly: false, lastSyncedAt: now - 1000,
  prices: [{ days: 1, pricePerDay: 50 }, { days: 3, pricePerDay: 130 / 3 }, { days: 30 }],
};
const response = (rows: unknown[]) => new Response(JSON.stringify({ status: "success", value: rows }));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("prepared Lab listing prices", () => {
  it("loads the owner-confirmed FX3 battery, charger and memory card into the prepared kit", () => {
    expect(renterBotLabScenario("sony-fx3-batteries")?.item.compatibility?.included_with_rental).toEqual(
      expect.arrayContaining(["3× Sony NP-FZ100 batteries", "1× 320GB CFexpress Type A card", "Sony dual battery charger"]),
    );
  });
  it("reads only the selected account and product's fresh listing tiers", async () => {
    const fetcher = vi.fn(async () => response([{ ...product, accountSlug: "leo" }, product]));
    const snapshot = await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", fetcher as typeof fetch, now);
    expect(snapshot).toMatchObject({ product_id: 1103089, daily_price_gbp: 50,
      price_tiers: [{ days: 1, pricePerDay: 50 }, { days: 3, pricePerDay: 130 / 3 }] });
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hearty-oyster-600.convex.cloud/api/query");
    expect(JSON.parse(String(request.body))).toEqual({ path: "hygglo_products:getByMasterItem",
      args: { masterItemId: product.masterItemId }, format: "json" });
  });

  it("marks the physical link verified only while the current exact listing mapping agrees", async () => {
    const fetcher = (componentId:string) => vi.fn(async (_url:unknown, init?:RequestInit) => {
      const path=JSON.parse(String(init?.body)).path;
      if(path==="listing_overrides:getRevision") return new Response(JSON.stringify({status:"success",value:{available:true,revision:JSON.stringify({
        account_slug:"dbcinema",product_id:1103089,components:[{item_id:componentId,qty:1}],
      })}}));
      return response([product]);
    });
    expect((await preparedListingPrice("bmpcc-6k-full-frame-kit","dbcinema",fetcher(product.masterItemId) as typeof fetch,now))?.mapping_verified).toBe(true);
    expect((await preparedListingPrice("bmpcc-6k-full-frame-kit","dbcinema",fetcher("other-item") as typeof fetch,now))?.mapping_verified).toBe(false);
  });

  it("withholds prices when the source is stale, ambiguous, unpublished or unavailable", async () => {
    for (const rows of [[], [product, product], [{ ...product, isMarketingOnly: true }],
      [{ ...product, isPublished: false }], [{ ...product, lastSyncedAt: now - 49 * 60 * 60 * 1000 }],
      [{ ...product, prices: [{ days: 3, pricePerDay: 40 }] }]]) {
      expect(await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", async () => response(rows), now)).toBeNull();
    }
    expect(await preparedListingPrice("bmpcc-6k-full-frame-kit", "leo", async () => response([product]), now)).toBeNull();
    expect(await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", async () => { throw Error("offline"); }, now)).toBeNull();
  });

  it("feeds the UI session's exact snapshot to the simulated order", async () => {
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", vi.fn(async () => response([product])));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = { runMutation: vi.fn(async (ref, args) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      return name === "renter_bot_lab_actions:ensurePreparedScenarioItem" ? "BMPCC 6K Full Frame" : {};
    }) };
    await (startLiveSession as any)._handler(ctx, { accountSlug: "dbcinema", scenarioId: "bmpcc-6k-full-frame-kit",
      lifecycle: "awaiting_owner_approval", startDate: "2026-11-26", endDate: "2026-11-26" });
    const seedArgs = calls.find(call => call.name === "renter_bot_lab_order:seed")?.args;
    expect(seedArgs?.prepared_price).toMatchObject({ product_id: 1103089, daily_price_gbp: 50 });
    // Regular and verification-failed examples must independently refresh
    // the same verified alternative, including withdrawing stale evidence.
    expect(calls.find(call => call.name === "renter_bot_lab_actions:ensurePreparedAlternative")?.args)
      .toMatchObject({ scenarioId: "bmpcc-6k-full-frame-kit", snapshot: null });
  });

  it("starts the failed-verification example as a cancelled test booking with its automatic reply visible", async () => {
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", vi.fn(async () => response([product])));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = { runMutation: vi.fn(async (ref, args) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      if (name === "renter_bot_lab_actions:ensurePreparedScenarioItem") return "BMPCC 6K Full Frame";
      if (name === "renter_bot_lab_order:__service_simulateVerificationFailure") return { message: verificationFailureReply(String(args.referral_code)) };
      return {};
    }) };
    const session = await (startLiveSession as any)._handler(ctx, { accountSlug: "dbcinema", scenarioId: "verification-failed",
      lifecycle: "awaiting_owner_approval", startDate: "2026-11-26", endDate: "2026-11-26" });
    expect(calls.find(call => call.name === "renter_bot_probe:seed")?.args.booking).toMatchObject({ order_step: "VERIFIED" });
    expect(calls.find(call => call.name === "renter_bot_lab_order:seed")?.args.prepared_price).toMatchObject({ product_id: 1103089, daily_price_gbp: 50 });
    expect(calls.find(call => call.name === "renter_bot_lab_order:__service_simulateVerificationFailure")?.args.thread_id).toMatch(/^__probe__/);
    expect(session.context.lifecycle).toBe("verification_failed");
    expect(session.context.initialBotMessage).toMatch(/automatically cancelled/i);
    expect(session.context.initialBotMessage).toMatch(/verified friend/i);
    expect(session.context.initialBotMessage).toMatch(/lower-value equipment/i);
    expect(session.context.initialBotMessage).not.toMatch(/Hygglo|Fat Llama/i);
  });

  it("uses the snapshot for the order and never substitutes a generic fallback", async () => {
    async function run(snapshot: Awaited<ReturnType<typeof preparedListingPrice>>, mapped = false) {
      let inserted: any;
      const item = { _id: "fixture-item", name_canonical: "BMPCC 6K Full Frame", status: "active", qty: 1 };
      const db = {
        query: (table: string) => table === "items" ? { collect: async () => [item] }
          : { withIndex: () => ({ unique: async () => mapped && table === "listing_resolution_override"
            ? {components:[{item_id:item._id,qty:1}]}
            : mapped && table === "hygglo_products" ? {masterItemId:item._id,isPublished:true,isMarketingOnly:false} : null }) },
        insert: async (_table: string, value: unknown) => { inserted = value; return "fixture-order"; },
      };
      await (seed as any)._handler({ db }, { thread_id: "__probe__price", account_slug: "dbcinema",
        item_names: [item.name_canonical], prepared_price: snapshot });
      return inserted.items;
    }
    const snapshot = await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", async () => response([product]), now);
    const lines = await run(snapshot);
    expect(lines[0]).toMatchObject({ source_product_id: 1103089, daily_price_gbp: 50, pricing_basis: "listing" });
    expect(summarise(lines, "2026-11-26", "2026-11-26").total_gbp).toBe(50);
    expect(summarise(lines, "2026-11-26", "2026-11-28").total_gbp).toBe(130);
    const missing = await run(null);
    expect(summarise(missing, "2026-11-26", "2026-11-26").total_gbp).toBeNull();
    const mapped = await run({...snapshot!,mapping_verified:true},true);
    expect(mapped[0].product_id).toBe(1103089);
    const unverified = await run({...snapshot!,mapping_verified:false},true);
    expect(unverified[0].product_id).toBeUndefined();
  });
});
