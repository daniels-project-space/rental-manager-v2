import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { mapPreparedComponentsToLabIds, matchesPreparedListing, preparedListingPrice, preparedOrderPrice } from "./lib/renter_bot_lab_listing_snapshot";
import { summarise, seed } from "./renter_bot_lab_order";
import { __service_runTestTurn, startLiveSession, startPreparedScenario } from "./renter_bot_lab_actions";
import { verificationFailureReply } from "./lib/verification_failure";
import { renterBotLabScenario } from "./lib/renter_bot_lab_scenarios";

const now = 1794480000000;
const product = {
  accountSlug: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf",
  isPublished: true, isMarketingOnly: false, lastSyncedAt: now - 1000,
  name: "Blackmagic 6K Full Frame Camera BMPCC 6K | Variable ND VND Filter",
  description: "Owner supplied Full Frame camera set with its verified accessories.",
  descriptionSyncedAt: now - 1000,
  publicUrl: "https://hygglo.com/uk/i/0f1-blackmagic-6k-full-frame-kit",
  prices: [{ days: 1, pricePerDay: 50 }, { days: 3, pricePerDay: 130 / 3 }, { days: 30 }],
};
const response = (rows: unknown[]) => new Response(JSON.stringify({ status: "success", value: rows }));
const fetchProduct = (listing: typeof product, mappedItems: string | Array<{ item_id: string; qty: number }> = listing.masterItemId) => vi.fn(async (_url: unknown, init?: RequestInit) => {
  const path = JSON.parse(String(init?.body)).path;
  if (path === "listing_overrides:getRevision") return new Response(JSON.stringify({ status: "success", value: { available: true,
    revision: JSON.stringify({ account_slug: listing.accountSlug, product_id: listing.productId,
      components: typeof mappedItems === "string" ? [{ item_id: mappedItems, qty: 1 }] : mappedItems }) } }));
  return response([listing]);
});
const fetchDiogoWithoutExactMapping = (listing: typeof product) => vi.fn(async (_url: unknown, init?: RequestInit) => {
  const path = JSON.parse(String(init?.body)).path;
  if (path === "listing_overrides:getRevision") return new Response(JSON.stringify({ status: "success", value: { available: true, revision: "null" } }));
  return response([listing]);
});

beforeEach(() => { vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("prepared Lab listing prices", () => {
  it("binds Diogo's kit listing to the shared Sony FX3 inventory identity", () => {
    expect(matchesPreparedListing("diogo", 1173763, "Sony FX3")).toBe(true);
    expect(matchesPreparedListing("diogo", 1173763, "Sony FX3 Full-Frame Camera Kit")).toBe(false);
  });

  it("loads the owner-confirmed FX3 battery, charger and memory card into the prepared kit", () => {
    expect(renterBotLabScenario("sony-fx3-batteries")?.item.compatibility?.included_with_rental).toEqual(
      expect.arrayContaining(["3× Sony NP-FZ100 batteries", "1× 320GB CFexpress Type A card", "Sony dual battery charger"]),
    );
  });
  it("uses the exact Diogo FX3 master item and current listing price", async () => {
    const diogoFx3 = { ...product, accountSlug: "diogo", productId: 1173763,
      masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw", name: "Sony FX3 Camera FX 3 4K Full Frame",
      description: "Sony FX3 camera kit with its owner-confirmed kit contents.",
      publicUrl: "https://hygglo.com/uk/i/448-sony-fx3-full-frame-cinema-camera",
      prices: [{ days: 1, pricePerDay: 45 }] };
    const fetcher = fetchDiogoWithoutExactMapping(diogoFx3);
    const snapshot = await preparedListingPrice("diogo-sony-fx3-kit", "diogo", fetcher as typeof fetch, now);
    expect(snapshot).toMatchObject({ account_slug: "diogo", product_id: 1173763, daily_price_gbp: 45,
      master_item_id: "kn7bw2cr1ye5hqj3x770b332ks86atzw", inventory_name: "Sony FX3",
      listing_name: diogoFx3.name, listing_description: diogoFx3.description,
      listing_description_synced_at: now - 1000, public_url: diogoFx3.publicUrl, mapping_verified: true,
      mapping_source: "owner-confirmed prepared Lab mapping",
      mapping_components: [{ item_id: "kn7bw2cr1ye5hqj3x770b332ks86atzw", qty: 1 }] });
    const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ path: "hygglo_products:getByMasterItem",
      args: { masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw" }, format: "json" });
  });

  it("uses the owner-confirmed Diogo mapping only for an explicit null revision", async () => {
    const diogoFx3 = { ...product, accountSlug: "diogo", productId: 1173763,
      masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw", name: "Sony FX3 Camera FX 3 4K Full Frame",
      description: "Sony FX3 camera kit with its owner-confirmed kit contents.",
      publicUrl: "https://hygglo.com/uk/i/448-sony-fx3-full-frame-cinema-camera",
      prices: [{ days: 1, pricePerDay: 45 }] };
    const invalidMappingResults = [
      { available: false },
      { available: true, revision: "not-json" },
      { available: true, revision: JSON.stringify({ account_slug: "leo", product_id: 1173763,
        components: [{ item_id: diogoFx3.masterItemId, qty: 1 }] }) },
    ];

    for (const mappingResult of invalidMappingResults) {
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const path = JSON.parse(String(init?.body)).path;
        if (path === "listing_overrides:getRevision") {
          return new Response(JSON.stringify({ status: "success", value: mappingResult }));
        }
        return response([diogoFx3]);
      });
      expect(await preparedListingPrice("diogo-sony-fx3-kit", "diogo", fetcher as typeof fetch, now)).toBeNull();
    }
  });

  it("preserves every component in an exact prepared listing mapping", async () => {
    const bodyId = "kn7bw2cr1ye5hqj3x770b332ks86atzw";
    const cardId = "kn78qeqezcrpjr12gzmynyfgb986b1rn";
    const leoFx3 = { ...product, accountSlug: "leo", productId: 1097510, masterItemId: bodyId,
      name: "Sony FX3 Camera 4K Full Frame", publicUrl: "https://hygglo.com/uk/i/leo-sony-fx3" };
    const snapshot = await preparedListingPrice("sony-fx3-batteries", "leo",
      fetchProduct(leoFx3, [{ item_id: bodyId, qty: 1 }, { item_id: cardId, qty: 1 }]) as typeof fetch, now);
    expect(snapshot).toMatchObject({ mapping_verified: true, mapping_components: [
      { item_id: bodyId, qty: 1 }, { item_id: cardId, qty: 1 },
    ] });
  });

  it("translates source inventory IDs to Lab IDs before comparing a multi-item mapping", () => {
    const sourceBodyId = "kn7bw2cr1ye5hqj3x770b332ks86atzw";
    const sourceCardId = "kn78qeqezcrpjr12gzmynyfgb986b1rn";
    const sourceComponents = [{ item_id: sourceBodyId, qty: 1 }, { item_id: sourceCardId, qty: 1 }];
    const localIdsBySource = new Map([[sourceBodyId, "lab-body-id"], [sourceCardId, "lab-card-id"]]);
    expect(mapPreparedComponentsToLabIds(sourceComponents, localIdsBySource)).toEqual([
      { item_id: "lab-body-id", qty: 1 }, { item_id: "lab-card-id", qty: 1 },
    ]);
    expect(mapPreparedComponentsToLabIds(sourceComponents, new Map([[sourceBodyId, "lab-body-id"]]))).toBeNull();
  });

  it.each(["prepared", "live"] as const)("hydrates the full Diogo listing through the %s Lab entry path", async (entry) => {
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const diogoFx3 = { ...product, accountSlug: "diogo", productId: 1173763,
      masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw", name: "Sony FX3 Camera FX 3 4K Full Frame",
      description: "Sony FX3 camera kit with current owner-confirmed listing details.",
      publicUrl: "https://hygglo.com/uk/i/448-sony-fx3-full-frame-cinema-camera",
      prices: [{ days: 1, pricePerDay: 45 }] };
    vi.stubGlobal("fetch", fetchDiogoWithoutExactMapping(diogoFx3));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = { runQuery: vi.fn(async () => { throw new Error("hosted scenarios must not query the local catalogue importer"); }), runMutation: vi.fn(async (ref, args) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      if (name === "renter_bot_lab_actions:ensurePreparedScenarioItem") return "Sony FX3";
      if (name === "renter_bot_lab_actions:ensurePreparedListing") return true;
      return {};
    }) };
    if (entry === "prepared") await (startPreparedScenario as any)._handler(ctx, { scenarioId: "diogo-sony-fx3-kit" });
    else await (startLiveSession as any)._handler(ctx, { accountSlug: "diogo", scenarioId: "diogo-sony-fx3-kit",
      lifecycle: "inquiry", startDate: "2026-12-10", endDate: "2026-12-10" });
    const listingArgs = calls.find(call => call.name === "renter_bot_lab_actions:ensurePreparedListing")?.args;
    expect(listingArgs?.snapshot).toMatchObject({ product_id: 1173763, listing_name: diogoFx3.name,
      listing_description: diogoFx3.description, public_url: diogoFx3.publicUrl, mapping_verified: true });
    expect(calls.find(call => call.name === "renter_bot_probe:seed")?.args.items)
      .toEqual([{ name: "Sony FX3", product_id: 1173763 }]);
    const orderArgs = calls.find(call => call.name === "renter_bot_lab_order:seed")?.args;
    expect(orderArgs?.prepared_price).toMatchObject({ product_id: 1173763, daily_price_gbp: 45 });
    expect(orderArgs?.prepared_price).not.toHaveProperty("listing_description");
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("lets a hosted isolated turn reach its session check without consulting local catalogue sync", async () => {
    const marker = `lab-auth-v1:${"0".repeat(64)}`;
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", "isolated-test-secret");
    vi.stubEnv("RENTER_BOT_LAB_AUTH_CONFIG_VERSION", marker);
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    const ctx = { runQuery: vi.fn(async () => null), runMutation: vi.fn() };

    await expect((__service_runTestTurn as any)._handler(ctx, {
      auth_marker: marker,
      threadId: "__probe__lab-hosted-turn",
      accountSlug: "dbcinema",
      text: "Can I collect it in Shoreditch?",
      turnId: "hosted-turn-0001",
      readinessProbe: false,
    })).rejects.toThrow("Lab session/account mismatch");
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
  });

  it("still requires a fresh full catalogue for local Lab sessions", async () => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    const ctx = { runQuery: vi.fn(async () => ({ status: "missing", fetched_at: null, inventory_count: 0, listing_count: 0 })),
      runMutation: vi.fn() };
    await expect((startLiveSession as any)._handler(ctx, {
      accountSlug: "dbcinema", scenarioId: "bmpcc-6k-full-frame-kit",
    })).rejects.toThrow("isolated Lab catalogue is missing, stale, or still syncing");
    expect(ctx.runQuery).toHaveBeenCalledTimes(1);
  });

  it("continues blocking hosted chat if real-renter messaging is ever enabled", async () => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "true");
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    const ctx = { runQuery: vi.fn(), runMutation: vi.fn() };
    await expect((startLiveSession as any)._handler(ctx, {
      accountSlug: "dbcinema", scenarioId: "bmpcc-6k-full-frame-kit",
    })).rejects.toThrow("Hosted Lab conversations require real-renter messaging to remain disabled");
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("does not let hosted mode open an ad hoc session without source-verified scenario data", async () => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    const ctx = { runQuery: vi.fn(), runMutation: vi.fn() };
    await expect((startLiveSession as any)._handler(ctx, {
      accountSlug: "dbcinema", items: ["BMPCC 6K Full Frame"], startDate: "2026-11-28", endDate: "2026-11-28",
    })).rejects.toThrow("Hosted Lab sessions require a prepared, source-verified rental scenario");
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("reads only the selected account and product's fresh listing tiers", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const path = JSON.parse(String(init?.body)).path;
      return path === "listing_overrides:getRevision"
        ? new Response(JSON.stringify({ status: "success", value: { available: true, revision: JSON.stringify({
          account_slug: "dbcinema", product_id: 1103089, components: [{ item_id: product.masterItemId, qty: 1 }],
        }) } }))
        : response([{ ...product, accountSlug: "leo" }, product]);
    });
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
    expect(await preparedListingPrice("bmpcc-6k-full-frame-kit","dbcinema",fetcher("other-item") as typeof fetch,now)).toBeNull();
  });

  it("rejects snapshots without a current description or with the wrong listing identity", async () => {
    for (const invalid of [
      { ...product, description: "  " },
      { ...product, descriptionSyncedAt: now - 49 * 60 * 60 * 1000 },
      { ...product, name: "Sony A7S III Camera Kit" },
      { ...product, publicUrl: "https://example.com/fake" },
    ]) {
      expect(await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", fetchProduct(invalid) as typeof fetch, now)).toBeNull();
    }
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
    vi.stubGlobal("fetch", fetchProduct(product));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = { runQuery: vi.fn(async () => ({ status: "ready", fetched_at: now, inventory_count: 108, listing_count: 1165,
      eligible_listing_count: 109, blocked_listing_count: 1056, source_receipts: [] })), runMutation: vi.fn(async (ref, args) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      if (name === "renter_bot_lab_actions:ensurePreparedScenarioItem") return "BMPCC 6K Full Frame";
      if (name === "renter_bot_lab_actions:ensurePreparedListing") return true;
      return {};
    }) };
    await (startLiveSession as any)._handler(ctx, { accountSlug: "dbcinema", scenarioId: "bmpcc-6k-full-frame-kit",
      lifecycle: "awaiting_owner_approval", startDate: "2026-11-26", endDate: "2026-11-26" });
    const seedArgs = calls.find(call => call.name === "renter_bot_lab_order:seed")?.args;
    expect(seedArgs?.prepared_price).toMatchObject({ product_id: 1103089, daily_price_gbp: 50 });
    expect(seedArgs?.prepared_price).not.toHaveProperty("listing_description");
    expect(calls.find(call => call.name === "renter_bot_lab_actions:ensurePreparedListing")?.args.snapshot)
      .toMatchObject({ listing_name: product.name, listing_description: product.description, public_url: product.publicUrl });
    // Regular and verification-failed examples must independently refresh
    // the same verified alternative, including withdrawing stale evidence.
    expect(calls.find(call => call.name === "renter_bot_lab_actions:ensurePreparedAlternative")?.args)
      .toMatchObject({ scenarioId: "bmpcc-6k-full-frame-kit", snapshot: null });
  });

  it("starts the failed-verification example as a cancelled test booking with its automatic reply visible", async () => {
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    vi.stubEnv("RENTAL_MANAGER_ACCESS", "open");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", fetchProduct(product));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = { runQuery: vi.fn(async () => ({ status: "ready", fetched_at: now, inventory_count: 108, listing_count: 1165,
      eligible_listing_count: 109, blocked_listing_count: 1056, source_receipts: [] })), runMutation: vi.fn(async (ref, args) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      if (name === "renter_bot_lab_actions:ensurePreparedScenarioItem") return "BMPCC 6K Full Frame";
      if (name === "renter_bot_lab_actions:ensurePreparedListing") return true;
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
            ? {components:[{item_id:item._id,qty:1},{item_id:"fixture-card",qty:1}]}
            : mapped && table === "hygglo_products" ? {masterItemId:item._id,isPublished:true,isMarketingOnly:false} : null }) },
        insert: async (_table: string, value: unknown) => { inserted = value; return "fixture-order"; },
      };
      await (seed as any)._handler({ db }, { thread_id: "__probe__price", account_slug: "dbcinema",
        item_names: [item.name_canonical], prepared_price: snapshot ? preparedOrderPrice(snapshot) : null });
      return inserted.items;
    }
    const snapshot = await preparedListingPrice("bmpcc-6k-full-frame-kit", "dbcinema", fetchProduct(product) as typeof fetch, now);
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
