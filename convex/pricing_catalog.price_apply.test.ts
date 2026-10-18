import { afterEach, describe, expect, it, vi } from "vitest";
import { publishRecommendationPrice } from "./pricing_catalog";

const job = {
  _id: "apply-job-1",
  _creationTime: 1,
  account_slug: "leo",
  pricing_row_id: "price-a",
  item_id: "item-a",
  product_id: 90210,
  item_name_canonical: "Camera body",
  old_price: 30,
  new_price: 34.5,
  demand_signature: "r1,r2,r3",
  status: "queued" as const,
  created_at: 1,
  updated_at: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recommendation Hygglo price worker", () => {
  it("updates only the exact mapped listing and verifies the live price", async () => {
    vi.stubEnv("ALLOW_RECOMMENDATION_PRICE_WRITES", "true");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ prices: [{ days: 1, pricePerDay: 30, price: 30 }, { days: 7, pricePerDay: 20, price: 140 }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: 90210 }))
      .mockResolvedValueOnce(jsonResponse({ prices: [{ days: 1, pricePerDay: 34.5, price: 34.5 }, { days: 7, pricePerDay: 20, price: 140 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      runQuery: vi.fn().mockResolvedValue(job),
      runMutation: vi.fn().mockResolvedValue({ ok: true }),
    };

    const result = await (publishRecommendationPrice as any)._handler(ctx, { jobId: job._id });

    expect(result).toMatchObject({ ok: true, productId: 90210 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["https://rental-manager-v2-nu.vercel.app/api/listings/leo/item/90210", "GET"],
      ["https://rental-manager-v2-nu.vercel.app/api/listings/leo/item/90210", "PATCH"],
      ["https://rental-manager-v2-nu.vercel.app/api/listings/leo/item/90210", "GET"],
    ]);
    const patch = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(patch.prices).toEqual([
      { days: 1, pricePerDay: 34.5, price: 34.5 },
      { days: 7, pricePerDay: 20, price: 140 },
    ]);
    expect(ctx.runMutation).toHaveBeenLastCalledWith(expect.anything(), { jobId: job._id, success: true });
  });

  it("refuses a live price drift without issuing a listing edit", async () => {
    vi.stubEnv("ALLOW_RECOMMENDATION_PRICE_WRITES", "true");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ prices: [{ days: 1, pricePerDay: 31, price: 31 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      runQuery: vi.fn().mockResolvedValue(job),
      runMutation: vi.fn().mockResolvedValue({ ok: false }),
    };

    const result = await (publishRecommendationPrice as any)._handler(ctx, { jobId: job._id });

    expect(result).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.runMutation).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      jobId: job._id,
      success: false,
      error: expect.stringContaining("Price changed since this recommendation was shown"),
    }));
  });
});
