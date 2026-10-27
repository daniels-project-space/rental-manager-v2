import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { inbox, emailInbox, replacementBasketOptions, thread, sendOwnerReply, draftReply } from "./dbcinema_chat";
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
  it("keeps owner activity separate from the genuine renter clock", async () => {
    expect(await read([], { lastSender: "owner", updatedAt: 300, lastRenterAt: 200 }))
      .toMatchObject({ last_renter_msg_at: 200, last_activity_at: 300 });
    expect(await read([], { lastSender: "system", updatedAt: 400, lastRenterAt: 200 }))
      .toMatchObject({ last_renter_msg_at: 200, last_activity_at: 400 });
  });
  it("never treats legacy owner activity as a new renter message", async () => {
    expect(await read([], { lastSender: "owner", updatedAt: 300 }))
      .toMatchObject({ last_renter_msg_at: 1 });
    expect(await read([], { lastSender: "renter", updatedAt: 300 }))
      .toMatchObject({ last_renter_msg_at: 300 });
  });
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
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");vi.stubEnv("RENTAL_MANAGER_ACCESS","owner");
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
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");vi.stubEnv("RENTAL_MANAGER_ACCESS","owner");
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

describe("general website support conversations",()=>{
 it("reads and replies using account scope, never a fabricated booking ID",async()=>{
  vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.stubEnv("DBCINEMA_CONVEX_URL","https://fixture.invalid");vi.stubEnv("DBCINEMA_ADMIN_TOKEN","fixture-only");
  const sent:any[]=[];vi.stubGlobal("fetch",vi.fn(async(_url:any,options:any)=>{
    const body=JSON.parse(options.body);sent.push(body);expect(body.args.accountId).toBe("fixture-account");expect(body.args.bookingId).toBeUndefined();
    return new Response(JSON.stringify({status:"success",value:body.path==="rentalChat:messages"?{page:[],escalated:true}:{ok:true}}));
  }));
  expect(await (thread as any)._handler({}, {booking_id:"support:fixture-account"})).toMatchObject({escalated:true});
  await (sendOwnerReply as any)._handler({}, {booking_id:"support:fixture-account",text:"Controlled unsent transport fixture"});
  expect(sent.map(s=>s.path)).toEqual(["rentalChat:messages","rentalChat:sendOwner"]);
 });
});

describe("human attention after an operator reply",()=>{
 it("keeps handoff attention only until the operator answers",async()=>{
  const waiting=await read([], {escalated:true,lastSender:"system"});
  expect(waiting.human_requested).toBe(true);
  const answered=await read([], {escalated:true,lastSender:"owner"});
  expect(answered.human_requested).toBe(false);
  expect(answered.last_sender).toBe("owner");
 });
});

describe("website conversation history pages",()=>{
 it("forwards older-message cursors and returns continuation metadata",async()=>{
  vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.stubEnv("DBCINEMA_CONVEX_URL","https://fixture.invalid");vi.stubEnv("DBCINEMA_ADMIN_TOKEN","fixture-only");
  const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(_url:string,options:RequestInit)=>{calls.push(JSON.parse(String(options.body)));return new Response(JSON.stringify({status:"success",value:{page:[{_id:"old",sender:"renter",text:"Older message",at:1}],isDone:false,continueCursor:"next-page"}}))}));
  const result=await(thread as any)._handler({}, {booking_id:"booking",cursor:"previous-page"});
  expect(calls[0]).toMatchObject({path:"rentalChat:messages",args:{paginationOpts:{numItems:40,cursor:"previous-page"}}});
  expect(result).toMatchObject({nextCursor:"next-page",messages:[{id:"old",content:"Older message"}]});
 });
 it("stops at the actual end instead of inventing another page",async()=>{
  vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.stubEnv("DBCINEMA_CONVEX_URL","https://fixture.invalid");vi.stubEnv("DBCINEMA_ADMIN_TOKEN","fixture-only");vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({status:"success",value:{page:[],isDone:true,continueCursor:"terminal"}}))));
  expect(await(thread as any)._handler({}, {booking_id:"booking"})).toMatchObject({nextCursor:null,messages:[]});
 });
});

describe("DB Cinema customer email in Quick Reply", () => {
  function configureOwnerBridge() {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
  }

  it("creates a labeled renter-waiting email row from the bounded remote inbox", async () => {
    configureOwnerBridge();
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      calls.push(body);
      return new Response(JSON.stringify({ status: "success", value: {
        authorized: true,
        items: [{ _id: "email-thread", email: "renter@example.com", name: "Renter", subject: "4 mic kits", status: "human_requested", lastAt: 90, lastDirection: "in", lastText: "Do you have four?", unreadOwner: 1, updatedAt: 90 }],
      } }));
    }));
    const rows = await (emailInbox as any)._handler({}, {});
    expect(calls[0]).toMatchObject({ path: "emailInbox:adminInbox", args: { limit: 100, token: "fixture-only" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "dbcinema_email",
      thread_id: "dbcinema-email:email-thread",
      source_booking_id: "email:email-thread",
      email_address: "renter@example.com",
      email_subject: "4 mic kits",
      renter_identity: "email:renter@example.com",
      last_sender: "renter",
      human_requested: true,
      has_reservation: false,
    });
  });

  it("links a verified email sender to the matching renter profile", async () => {
    configureOwnerBridge();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "success", value: {
      authorized: true,
      items: [{ _id: "email-thread", email: "renter@example.com", verifiedRenterEmail: "renter@example.com", name: "Unverified sender name", subject: "Rental question", status: "open", lastAt: 90, lastDirection: "in", lastText: "Is the kit free?", unreadOwner: 1, updatedAt: 90 }],
    } }))));
    const runQuery = vi.fn(async (_query: unknown, _args: unknown) => [{
      email: "renter@example.com",
      renter_identity: "hygglo:existing-renter",
      rating: 4.9,
      review_count: 12,
      display_name: "Renter profile",
      profile_image_url: "https://images.example/renter.jpg",
      blacklisted: false,
      flagged: true,
    }]);
    const rows = await (emailInbox as any)._handler({ runQuery }, {});
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][1]).toEqual({ emails: ["renter@example.com"] });
    expect(rows[0]).toMatchObject({
      renter_identity: "hygglo:existing-renter",
      renter_name: "Renter profile",
      renter_image_url: "https://images.example/renter.jpg",
      renter_rating: 4.9,
      renter_review_count: 12,
      renter_flagged: true,
    });
  });

  it("loads email history, marks it read, and replies through the business-mail action", async () => {
    configureOwnerBridge();
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      calls.push(body);
      const value = body.path === "emailInbox:adminThread"
        ? { authorized: true, thread: { status: "human_requested" }, messages: [{ _id: "in-1", direction: "in", text: "Need four mic kits", at: 10 }] }
        : { ok: true };
      return new Response(JSON.stringify({ status: "success", value }));
    }));
    const history = await (thread as any)._handler({}, { booking_id: "email:email-thread" });
    expect(history).toMatchObject({ escalated: true, messages: [{ id: "in-1", role: "renter", content: "Need four mic kits" }] });
    await (sendOwnerReply as any)._handler({}, { booking_id: "email:email-thread", text: " Thanks, I will check. " });
    expect(calls.map((call) => call.path)).toEqual([
      "emailInbox:adminThread",
      "emailInbox:markRead",
      "emailInbox:sendOwnerReply",
    ]);
    expect(calls[2]).toMatchObject({ args: { threadId: "email-thread", text: "Thanks, I will check.", token: "fixture-only" } });
  });

  it("drafts from the email history without sending", async () => {
    configureOwnerBridge();
    vi.stubEnv("NOTIF_BASE_URL", "https://draft.fixture.invalid");
    vi.stubEnv("RENTER_BOT_API_SECRET", "fixture-draft-secret");
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/api/dbcinema-chat-draft")) {
        calls.push({ url, body: JSON.parse(String(options.body)) });
        return new Response(JSON.stringify({ draft: "I can confirm the available mic options." }));
      }
      const body = JSON.parse(String(options.body));
      calls.push(body);
      return new Response(JSON.stringify({ status: "success", value: {
        authorized: true,
        thread: { email: "renter@example.com", name: "Renter", subject: "4 mic kits" },
        messages: [{ direction: "in", text: "Need four mic kits", at: 10 }],
      } }));
    }));
    const result = await (draftReply as any)._handler({}, { booking_id: "email:email-thread" });
    expect(result).toEqual({ draft: "I can confirm the available mic options." });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.messages).toEqual([{ role: "renter", text: "Need four mic kits", at: 10 }]);
  });
});
