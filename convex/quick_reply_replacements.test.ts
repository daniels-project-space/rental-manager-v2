import { describe, it, expect, vi, afterEach } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: vi.fn(async () => ({ _id: "fixture-owner" })),
  },
}));
afterEach(() => vi.unstubAllEnvs());
import { basketOptions } from "./quick_reply_replacements";
function fixture() {
  vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  const calls: any[] = [];
  const state = {
    ok: true,
    dates: { start: "2026-11-05", end: "2026-11-07" },
    actions: { add_product: true },
    items: [
      {
        item_id: 1001,
        product_id: 10,
        name: "Original camera full listing title",
        can_remove: true,
      },
      {
        item_id: 1002,
        product_id: 11,
        name: "Original lens full listing title",
        can_remove: true,
      },
      {
        item_id: 1003,
        product_id: 12,
        name: "Retained tripod",
        can_remove: true,
      },
    ],
  };
  const tile = {
    account_slug: "leo",
    has_reservation: true,
    start_date: "2026-11-01",
    end_date: "2026-11-02",
    items: [
      { name: "Original camera", qty: 1, product_id: 10 },
      { name: "Original lens", qty: 1, product_id: 11 },
      { name: "Retained tripod", qty: 1, product_id: 12 },
    ],
    availability: {
      status: "conflict",
      items: [
        { item_index: 0, available: false },
        { item_index: 1, available: false },
        { item_index: 2, available: true },
      ],
    },
  };
  let currentAvailable: boolean | null = false;
  let unavailableProducts = [10, 11];
  const ctx: any = {
    auth: {
      getUserIdentity: async () => ({
        subject: "fixture-owner",
        issuer: "https://example.convex.site",
      }),
    },
    runMutation: vi.fn(() => {
      throw Error("No mutation allowed in options");
    }),
    runAction: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name !== "order_edit:__service_getOrderState")
        throw Error("Unexpected action");
      return state;
    },
    runQuery: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === "owner_access:get") return { auth_user_id: "fixture-owner" };
      if (name === "replyInbox:__service_getThreadById") return tile;
      if (name === "quick_reply_basket_stock:check")
        return {
          available: args.lines.some((line: any) => line.product_id === 10)
            ? currentAvailable
            : true,
          ...(args.include_line_checks
            ? {
                line_checks: args.lines.map(
                  (line: any, item_index: number) => ({
                    item_index,
                    available:
                      currentAvailable == null
                        ? null
                        : !unavailableProducts.includes(line.product_id),
                  }),
                ),
              }
            : {}),
        };
      if (name === "renter_bot_tools:__service_basket_replacement_candidates")
        return {
          alternatives: [0, 1].map((offset) => ({
            name: args.item_name.includes("camera")
              ? "Replacement camera"
              : "Replacement lens",
            product_id: (args.item_name.includes("camera") ? 20 : 30) + offset,
            availability: { available: true },
            mapping_complete: true,
            storage_contents_verification_required: false,
          })),
        };
      if (name === "online_listings:__service_list")
        return [20, 21, 30, 31].map((pid) => ({
          product_id: pid,
          display_name: "Exact listing " + pid,
          image: "/fresh-" + pid,
        }));
      throw Error("Unexpected query " + name);
    },
  };
  return {
    ctx,
    calls,
    state,
    tile,
    setUnavailableProducts: (ids: number[]) => {
      unavailableProducts = ids;
    },
    setCurrentStock: (value: boolean | null) => {
      currentAvailable = value;
    },
  };
}
const invoke = (ctx: any) =>
  (basketOptions as any)._handler(ctx, { thread_id: "native-thread" });
describe("registered complete native basket replacement finder", () => {
  it("uses fresh dates and product identities, checks complete sets and never writes", async () => {
    const f = fixture(),
      r = await invoke(f.ctx);
    expect(r.options).toHaveLength(2);
    expect(r.originals.map((o: any) => o.order_item.item_id)).toEqual([
      1001, 1002,
    ]);
    expect(
      r.options.every((o: any) => o.can_apply && o.items.length === 2),
    ).toBe(true);
    const candidates = f.calls.filter(
      (c) =>
        c.name === "renter_bot_tools:__service_basket_replacement_candidates",
    );
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.args.target_product_id)).toEqual([10, 11]);
    for (const { args } of candidates) {
      expect(args).toMatchObject({
        start_date: "2026-11-05",
        end_date: "2026-11-07",
        omit_product_ids: [10, 11],
        basket_lines: f.state.items.map((i) => ({
          name: i.name,
          qty: 1,
          product_id: i.product_id,
        })),
      });
      expect(args.camera_requirements).toBeUndefined();
      expect(args.lens_requirements).toBeUndefined();
    }
    const stock = f.calls.filter(
      (c) => c.name === "quick_reply_basket_stock:check",
    );
    expect(stock).toHaveLength(3);
    for (const { args } of stock) {
      expect(args.start).toBe("2026-11-05");
      expect(args.end).toBe("2026-11-07");
    }
    for (const { args } of stock.slice(1)) {
      expect(args.lines).toHaveLength(3);
      expect(args.lines.some((l: any) => l.product_id === 12)).toBe(true);
      expect(args.lines.some((l: any) => [10, 11].includes(l.product_id))).toBe(
        false,
      );
    }
    expect(r.options[0].items[0]).toMatchObject({
      name: "Exact listing 20",
      image_url: "/fresh-20",
      image_urls: ["/fresh-20"],
    });
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("does not replace gear now available or with unknown current stock", async () => {
    for (const value of [true, null]) {
      const f = fixture();
      f.setCurrentStock(value);
      expect((await invoke(f.ctx)).options).toEqual([]);
      expect(
        f.calls.some(
          (c) =>
            c.name ===
            "renter_bot_tools:__service_basket_replacement_candidates",
        ),
      ).toBe(false);
      expect(f.ctx.runMutation).not.toHaveBeenCalled();
    }
  });
  it("replaces every currently unavailable line instead of the stale queue subset", async () => {
    const f = fixture();
    f.setUnavailableProducts([10, 12]);
    const r = await invoke(f.ctx);
    expect(r.originals.map((o: any) => o.order_item.product_id)).toEqual([
      10, 12,
    ]);
    expect(r.options).toHaveLength(2);
    const candidates = f.calls.filter(
      (c) =>
        c.name === "renter_bot_tools:__service_basket_replacement_candidates",
    );
    expect(candidates.map((c) => c.args.item_name)).toEqual([
      "Original camera",
      "Retained tripod",
    ]);
    expect(
      candidates.every(
        (c) => JSON.stringify(c.args.omit_product_ids) === "[10,12]",
      ),
    ).toBe(true);
    const sets = f.calls.filter(
      (c) =>
        c.name === "quick_reply_basket_stock:check" &&
        !c.args.include_line_checks,
    );
    expect(
      sets.every((c) =>
        c.args.lines.some((line: any) => line.product_id === 11),
      ),
    ).toBe(true);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("fresh stock follows the current order line sequence after reordering", async () => {
    const f = fixture();
    f.state.items.reverse();
    const r = await invoke(f.ctx);
    expect(r.originals.map((o: any) => o.order_item.product_id)).toEqual([
      11, 10,
    ]);
    expect(r.originals.map((o: any) => o.item_index)).toEqual([1, 2]);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("includes newly added unavailable order lines absent from the cached request", async () => {
    const f = fixture();
    f.state.items.push({
      item_id: 1004,
      product_id: 14,
      name: "New lens",
      can_remove: true,
    });
    f.setUnavailableProducts([10, 14]);
    const r = await invoke(f.ctx);
    expect(r.originals.map((o: any) => o.order_item.product_id)).toEqual([
      10, 14,
    ]);
    expect(r.originals[1].name).toBe("New lens");
    expect(r.options).toHaveLength(2);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("checks enquiry stock freshly and offers complete sets without applying an order edit", async () => {
    const f = fixture();
    f.tile.has_reservation = false;
    f.setUnavailableProducts([10, 12]);
    const r = await invoke(f.ctx);
    expect(r.originals.map((o: any) => o.item_index)).toEqual([0, 2]);
    expect(r.options).toHaveLength(2);
    expect(
      r.options.every((o: any) => !o.can_apply && o.items.length === 2),
    ).toBe(true);
    expect(
      f.calls.some((c) => c.name === "order_edit:__service_getOrderState"),
    ).toBe(false);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("continues every unavailable item across catalogue pages before checking complete sets", async () => {
    const f = fixture(),
      base = f.ctx.runQuery,
      pages: any[] = [];
    f.ctx.runQuery = async (ref: any, args: any) => {
      if (
        getFunctionName(ref) ===
        "renter_bot_tools:__service_basket_replacement_candidates"
      ) {
        pages.push({
          product: args.target_product_id,
          cursor: args.candidate_cursor ?? null,
        });
        if (!args.candidate_cursor)
          return {
            alternatives: [],
            is_done: false,
            continue_cursor: "next-page",
            reason: "No matches on this page",
          };
        return {
          ...(await base(ref, args)),
          is_done: true,
          continue_cursor: null,
        };
      }
      return base(ref, args);
    };
    const r = await invoke(f.ctx);
    expect(r.options).toHaveLength(2);
    expect(pages).toEqual([
      { product: 10, cursor: null },
      { product: 10, cursor: "next-page" },
      { product: 11, cursor: null },
      { product: 11, cursor: "next-page" },
    ]);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("bounds an unfinished catalogue and stops repeated cursors without writes", async () => {
    for (const repeated of [false, true]) {
      const f = fixture(),
        base = f.ctx.runQuery;
      let pages = 0;
      f.ctx.runQuery = async (ref: any, args: any) => {
        if (
          getFunctionName(ref) ===
          "renter_bot_tools:__service_basket_replacement_candidates"
        )
          return {
            alternatives: [],
            is_done: false,
            continue_cursor: repeated ? "stalled" : String(++pages),
          };
        return base(ref, args);
      };
      const r = await invoke(f.ctx);
      expect(r.options).toEqual([]);
      expect(r.reason).toContain("bounded search");
      expect(pages).toBe(repeated ? 0 : 64);
      expect(f.ctx.runMutation).not.toHaveBeenCalled();
    }
  });
  it("stops malformed catalogue cursors before sending another page query", async () => {
    const f = fixture(),
      base = f.ctx.runQuery;
    let calls = 0;
    f.ctx.runQuery = async (ref: any, args: any) => {
      if (
        getFunctionName(ref) ===
        "renter_bot_tools:__service_basket_replacement_candidates"
      ) {
        calls++;
        return {
          alternatives: [],
          is_done: false,
          continue_cursor: { invalid: true },
        };
      }
      return base(ref, args);
    };
    expect((await invoke(f.ctx)).options).toEqual([]);
    expect(calls).toBe(2);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("denies unauthenticated access before order or stock reads", async () => {
    const f = fixture();
    f.ctx.auth.getUserIdentity = async () => null;
    await expect(invoke(f.ctx)).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(f.calls).toEqual([]);
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
});
