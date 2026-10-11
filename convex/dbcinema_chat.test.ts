import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { inbox, replacementBasketOptions } from "./dbcinema_chat";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const stock = {
  available: true,
  availableUnits: 2,
  ownedUnits: 2,
  requestedQty: 1,
};
async function read(items: unknown[], proof = {}) {
  vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
  vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
  vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    expect(JSON.parse(String(options.body)).path).toBe("rentalChat:adminInbox");
    return new Response(
      JSON.stringify({
        status: "success",
        value: {
          authorized: true,
          items: [
            {
              _id: "fixture-booking",
              accountId: "fixture-person",
              name: "Fixture renter",
              lastMessage: "Is this available?",
              lastSender: "renter",
              createdAt: 1,
              updatedAt: 99,
              items,
              status: "pending_payment",
              ...proof,
            },
          ],
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const rows = await (inbox as any)._handler(
    { runQuery: vi.fn(async () => []) },
    {},
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return rows[0];
}
describe("website Quick Reply full-basket stock and lifecycle", () => {
  it("requires every item to be checked before displaying available", async () => {
    const row = await read([
      { name: "Camera", stockAvailability: stock },
      { name: "Lens" },
    ]);
    expect(row.availability).toMatchObject({
      status: "unknown",
      reason: "Full basket needs a stock review",
    });
    expect(row.availability.checked_at).toBeGreaterThan(0);
    expect(row.request_created_at).toBe(1);
    expect(row.last_activity_at).toBe(99);
    expect(row.availability.items).toHaveLength(2);
    expect(row.availability.items[1]).toMatchObject({
      item_index: 1,
      name: "Lens",
      available: null,
    });
  });
  it("preserves a verified conflict even when another line is unchecked", async () => {
    expect(
      (
        await read([
          { name: "Camera", stockAvailability: { ...stock, available: false } },
          { name: "Lens" },
        ])
      ).availability.status,
    ).toBe("conflict");
  });
  it("reports available only for a fully checked basket", async () => {
    expect(
      (
        await read([
          { name: "Camera", stockAvailability: stock },
          { name: "Lens", stockAvailability: stock },
        ])
      ).availability.status,
    ).toBe("available");
  });
  it("keeps a basket with no stock results unknown", async () => {
    expect((await read([{ name: "Camera" }])).availability.status).toBe(
      "unknown",
    );
  });
  it("does not promote unpaid website enquiries", async () => {
    expect(
      await read([], {
        idVerifyStatus: "verified",
        verificationUpdatedAt: 1,
        verificationArchiveReady: true,
      }),
    ).toMatchObject({ paid: false, platform_booking_confirmed: false });
  });
  it("requires dated verification start and archive proof to confirm", async () => {
    expect(
      await read([], { status: "confirmed", idVerifyStatus: "processing" }),
    ).toMatchObject({
      paid: true,
      verification_started: false,
      platform_booking_confirmed: false,
    });
    expect(
      await read([], {
        status: "confirmed",
        idVerifyStatus: "processing",
        verificationUpdatedAt: 1,
      }),
    ).toMatchObject({
      verification_started: true,
      platform_booking_confirmed: false,
    });
    expect(
      await read([], {
        status: "confirmed",
        idVerifyStatus: "verified",
        verificationUpdatedAt: 1,
        verificationArchiveReady: true,
      }),
    ).toMatchObject({ platform_booking_confirmed: true });
  });
});

describe("owner website rental controls bridge", () => {
  async function setup(value: unknown) {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-server-token");
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, ...JSON.parse(String(options.body)) });
        return new Response(JSON.stringify({ status: "success", value }));
      }),
    );
    return {
      requests,
      ctx: { runQuery: vi.fn() },
      module: await import("./dbcinema_chat"),
    };
  }
  it("denies anonymous controls before contacting the website", async () => {
    const f = await setup({});
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    await expect(
      (f.module.rentalControls as any)._handler(
        { auth: { getUserIdentity: async () => null }, runQuery: vi.fn() },
        { booking_id: "booking" },
      ),
    ).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(f.requests).toEqual([]);
  });
  it("returns only control fields and reads without writes", async () => {
    const f = await setup({
      status: "confirmed",
      total: 350,
      depositHoldAmount: 100,
      controlsSnapshot: "version",
      lineItems: [
        { title: "Camera", qty: 1, start: 1, end: 2, heroImage: "image" },
      ],
      rentalRefunds: [],
      stripePaymentIntentId: "private",
      guestEmail: "private",
    });
    const result = await (f.module.rentalControls as any)._handler(f.ctx, {
      booking_id: "booking",
    });
    expect(result).toMatchObject({
      snapshot: "version",
      canChangeDates: true,
      lines: [{ name: "Camera", qty: 1 }],
    });
    expect(result).not.toHaveProperty("stripePaymentIntentId");
    expect(result).not.toHaveProperty("guestEmail");
    expect(f.requests[0]).toMatchObject({
      url: "https://fixture.invalid/api/query",
      path: "rentalOperations:details",
      args: { bookingId: "booking", token: "fixture-server-token" },
    });
  });
  it("previews dates through the shared website qualification query", async () => {
    const f = await setup({ ok: false, reason: "Already reserved" });
    expect(
      await (f.module.previewRentalDates as any)._handler(f.ctx, {
        booking_id: "booking",
        start: 1,
        end: 2,
        reason: "Operator reason",
        keep_agreed_price: true,
      }),
    ).toMatchObject({ ok: false });
    expect(f.requests[0]).toMatchObject({
      url: "https://fixture.invalid/api/query",
      path: "rentalOperations:previewReschedule",
    });
  });
  it("requires explicit confirmation then binds the exact date review", async () => {
    const f = await setup({ ok: true }),
      args = {
        booking_id: "booking",
        start: 1,
        end: 2,
        reason: "Operator reason",
        keep_agreed_price: true,
        expected_snapshot: "reviewed-version",
        operator_confirmed: false,
      };
    await expect(
      (f.module.applyRentalDates as any)._handler(f.ctx, args),
    ).rejects.toThrow("Review and confirm");
    expect(f.requests).toEqual([]);
    await (f.module.applyRentalDates as any)._handler(f.ctx, {
      ...args,
      operator_confirmed: true,
    });
    expect(f.requests[0]).toMatchObject({
      path: "rentalOperations:reschedule",
      args: { expectedSnapshot: "reviewed-version", keepAgreedPrice: true },
    });
  });
  it("preserves the website refund action, exact pence and operator request id", async () => {
    const f = await setup({ status: "pending", amount: 12.5 }),
      args = {
        booking_id: "booking",
        request_id: "operator-stable-id",
        amount_pence: 1250,
        reason: "Operator discount",
        operator_confirmed: false,
      };
    await expect(
      (f.module.refundRental as any)._handler(f.ctx, args),
    ).rejects.toThrow("Review the amount");
    expect(f.requests).toEqual([]);
    expect(
      await (f.module.refundRental as any)._handler(f.ctx, {
        ...args,
        operator_confirmed: true,
      }),
    ).toMatchObject({ status: "pending" });
    expect(f.requests[0]).toMatchObject({
      url: "https://fixture.invalid/api/action",
      path: "checkout:refundRental",
      args: { requestId: "operator-stable-id", amountPence: 1250 },
    });
  });
});

describe("inline website equipment controls", () => {
  async function setup(value: unknown = { ok: true }) {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-owner-only");
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({ url, ...JSON.parse(String(options.body)) });
        return new Response(
          JSON.stringify({
            status: "success",
            value:
              typeof value === "function"
                ? (value as (path: string) => unknown)(requests.at(-1).path)
                : value,
          }),
        );
      }),
    );
    return {
      requests,
      ctx: { runQuery: vi.fn() },
      module: await import("./dbcinema_chat"),
    };
  }
  it("keeps equipment browse and quote on readonly source queries", async () => {
    const f = await setup((path: string) =>
      path === "rentalOperations:equipmentCatalog"
        ? [
            {
              listingId: "lens",
              title: "Lens",
              daily: 30,
              imageSources: ["/lens.jpg"],
            },
          ]
        : { ok: true, imageSources: ["/lens.jpg"] },
    );
    const catalog = await (f.module.equipmentCatalog as any)._handler(f.ctx, {
      search: "lens",
    });
    await (f.module.previewEquipmentAddition as any)._handler(f.ctx, {
      booking_id: "rental",
      listing_id: "lens",
      qty: 2,
      reason: "Customer needs two lenses",
      complimentary: false,
    });
    expect(catalog[0].imageSources).toEqual([
      "https://dbcinemarentals.com/lens.jpg",
    ]);
    expect(f.requests.map((r) => r.path)).toEqual([
      "rentalOperations:equipmentCatalog",
      "rentalAdditionState:preview",
    ]);
    expect(f.requests.every((r) => r.url.endsWith("/api/query"))).toBe(true);
    expect(f.requests[1].args).toMatchObject({
      bookingId: "rental",
      listingId: "lens",
      qty: 2,
      token: "fixture-owner-only",
    });
  });
  it("requires confirmation and binds the exact quote and request to addition", async () => {
    const f = await setup({
        url: "https://fixture.invalid/pay",
        id: "addition",
      }),
      args = {
        booking_id: "rental",
        listing_id: "lens",
        request_id: "fixture-addition-request",
        qty: 1,
        reason: "Customer requested lens",
        complimentary: false,
        expected_snapshot: "version",
        expected_quote: "quote",
        operator_confirmed: false,
      };
    await expect(
      (f.module.addEquipment as any)._handler(f.ctx, args),
    ).rejects.toThrow("Review and confirm");
    expect(f.requests).toEqual([]);
    expect(
      await (f.module.addEquipment as any)._handler(f.ctx, {
        ...args,
        operator_confirmed: true,
      }),
    ).toMatchObject({ addition_id: "addition", applied: false });
    expect(f.requests[0]).toMatchObject({
      path: "rentalAdditions:start",
      args: {
        expectedSnapshot: "version",
        expectedQuote: "quote",
        requestId: "fixture-addition-request",
        listingId: "lens",
      },
    });
  });
  it("requires confirmation and exact line state for removal", async () => {
    const f = await setup(),
      args = {
        booking_id: "rental",
        listing_id: "lens",
        request_id: "fixture-removal-request",
        line_index: 2,
        qty: 1,
        start: 1,
        end: 2,
        reason: "Customer needs fewer lenses",
        expected_snapshot: "version",
        operator_confirmed: false,
      };
    await expect(
      (f.module.removeEquipment as any)._handler(f.ctx, args),
    ).rejects.toThrow("Review and confirm");
    expect(f.requests).toEqual([]);
    await (f.module.removeEquipment as any)._handler(f.ctx, {
      ...args,
      operator_confirmed: true,
    });
    expect(f.requests[0]).toMatchObject({
      path: "rentalOperations:removeItem",
      args: {
        lineIndex: 2,
        expectedQty: 1,
        expectedStart: 1,
        expectedEnd: 2,
        expectedSnapshot: "version",
        requestId: "fixture-removal-request",
      },
    });
  });
  it("rejects anonymous equipment operations before any provider call", async () => {
    const f = await setup();
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    const ctx = {
      auth: { getUserIdentity: async () => null },
      runQuery: vi.fn(),
    };
    for (const name of [
      "equipmentCatalog",
      "previewEquipmentAddition",
      "addEquipment",
      "removeEquipment",
    ]) {
      await expect((f.module as any)[name]._handler(ctx, {})).rejects.toThrow(
        "OWNER_AUTH_REQUIRED",
      );
    }
    expect(f.requests).toEqual([]);
  });
});

describe("equipment review refusal versus unknown outcome", () => {
  it("only a structured source refusal permits a fresh review", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-owner-only");
    const module = await import("./dbcinema_chat"),
      ctx = { runQuery: vi.fn() },
      args = {
        booking_id: "rental",
        listing_id: "lens",
        request_id: "fixture-request",
        qty: 1,
        reason: "Operator approved lens",
        complimentary: false,
        expected_snapshot: "version",
        expected_quote: "quote",
        operator_confirmed: true,
      };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "error",
              errorData: { code: "EQUIPMENT_REVIEW_STALE" },
            }),
          ),
      ),
    );
    expect(await (module.addEquipment as any)._handler(ctx, args)).toEqual({
      review_required: true,
    });
    expect(
      await (module.removeEquipment as any)._handler(ctx, {
        ...args,
        line_index: 0,
        start: 1,
        end: 2,
      }),
    ).toEqual({ review_required: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "error",
              errorMessage: "The rental changed. Review again.",
            }),
          ),
      ),
    );
    await expect(
      (module.addEquipment as any)._handler(ctx, args),
    ).rejects.toThrow("temporarily unavailable");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("Unknown transport result");
      }),
    );
    await expect(
      (module.addEquipment as any)._handler(ctx, args),
    ).rejects.toThrow("Unknown transport result");
  });
});

describe("replacement image sources", () => {
  it("normalizes website-relative fallback images without altering the replacement snapshot", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
    const original = { lines: [{ listingId: "original", qty: 1 }] };
    const image = {
      name: "Camera",
      image_url: "/primary.png",
      image_urls: [
        "/alternate.png",
        "https://photos.rental-test.invalid/third.png",
        "data:invalid",
      ],
    };
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(JSON.parse(String(options.body)).path).toBe(
        "rentalReplacements:basketOptions",
      );
      return new Response(
        JSON.stringify({
          status: "success",
          value: {
            originals: [image],
            options: [
              {
                id: "replacement",
                original,
                items: [{ ...image, id: "replacement", qty: 1 }],
              },
            ],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await (replacementBasketOptions as any)._handler(
      {},
      { booking_id: "fixture-booking" },
    );
    const expected = [
      "https://dbcinemarentals.com/primary.png",
      "https://dbcinemarentals.com/alternate.png",
      "https://photos.rental-test.invalid/third.png",
    ];
    expect(result.originals[0].image_urls).toEqual(expected);
    expect(result.options[0].items[0].image_urls).toEqual(expected);
    expect(result.options[0].original).toEqual(original);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
