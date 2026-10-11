"use node";
import { action, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { callDbCinema } from "./dbcinema_chat";
import { replacementSets } from "./lib/replacement_sets";
import {
  basketSwapSnapshot,
  executeNativeBasketSwap,
  executeNativeSwap,
  nativeSwapSnapshot,
} from "./lib/quick_reply_swap";

async function nativeOptions(
  ctx: any,
  thread_id: string,
  item_index: number,
): Promise<{ options: any[]; reason: string | null | undefined }> {
  const tile = await ctx.runQuery(internal.replyInbox.__service_getThreadById, {
    thread_id,
  });
  if (
    !tile?.account_slug ||
    !tile.start_date ||
    !tile.end_date ||
    tile.availability?.status !== "conflict"
  )
    return { options: [], reason: "No confirmed stock problem was found." };
  const item = tile.items[item_index];
  if (!item) throw Error("Refresh and choose the item again.");

  const st = tile.has_reservation
    ? await ctx.runAction(internal.order_edit.__service_getOrderState, {
        account_slug: tile.account_slug,
        hygglo_order_id: thread_id,
      })
    : {
        ok: false,
        items: [],
        actions: { add_product: false },
        dates: { start: tile.start_date, end: tile.end_date },
      };
  const old =
    st.items?.find((i: any) => i.name === item.name) ??
    (tile.items.length === 1 && st.items?.length === 1 ? st.items[0] : null);
  const result = await ctx.runQuery(
    internal.renter_bot_tools.__service_basket_replacement_candidates,
    {
      account_slug: tile.account_slug,
      item_name: item.name,
      exclude_name: item.name,
      start_date: tile.start_date,
      end_date: tile.end_date,
      quantity: item.qty,
      thread_id,
      booking_use: tile.has_reservation ? "replacement" : "standalone",
      ...(old?.product_id
        ? { replace_product_id: old.product_id, replace_quantity: item.qty }
        : {}),
    },
  );
  const listings = await ctx.runQuery(internal.online_listings.__service_list, {
    account_slug: tile.account_slug,
  });
  return {
    options: (result.alternatives ?? [])
      .filter(
        (i: any) =>
          i.availability?.available === true &&
          i.product_id &&
          i.mapping_complete &&
          !i.storage_contents_verification_required,
      )
      .map((i: any) => ({
        id: String(i.product_id),
        name: i.listing_name ?? i.name,
        image_url:
          i.image_url ??
          listings?.find((l: any) => l.product_id === i.product_id)?.image ??
          null,
        available: true,
        original: {
          account_slug: tile.account_slug,
          item_id: old?.item_id ?? null,
          product_id: old?.product_id ?? null,
          name: item.name,
          start: st.dates?.start ?? tile.start_date,
          end: st.dates?.end ?? tile.end_date,
        },
        can_apply: !!(
          old?.can_remove &&
          st.actions?.add_product &&
          item.qty === 1
        ),
        price_note:
          "Hygglo recalculates the order when kit changes. Check its price before sending.",
      })),
    reason: result.error ?? null,
  };
}
export const options = action({
  args: { thread_id: v.string(), item_index: v.number() },
  handler: async (
    ctx,
    a,
  ): Promise<{ options: any[]; reason: string | null | undefined }> => {
    await requireOwner(ctx);
    return nativeOptions(ctx, a.thread_id, a.item_index);
  },
});
export const accept = action({
  args: {
    thread_id: v.string(),
    item_index: v.number(),
    replacement_id: v.string(),
    original: v.any(),
    request_id: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<any> => {
    await requireOwner(ctx);
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(a.request_id))
      throw Error("Invalid replacement request.");
    const receipt = await ctx.runQuery(
      internal.quick_reply_swap_ledger.receipt,
      { request_id: a.request_id },
    );
    if (receipt) {
      if (
        receipt.thread_id !== a.thread_id ||
        receipt.snapshot !== nativeSwapSnapshot(a.original, a.replacement_id)
      )
        throw Error("Replacement request changed.");
      if (receipt.state === "applied") return { ok: true, replayed: true };
      throw Error(
        "This replacement already ran. Check the order before further changes.",
      );
    }
    const fresh = await nativeOptions(ctx, a.thread_id, a.item_index);
    const candidate = fresh.options.find((i: any) => i.id === a.replacement_id);
    if (
      !candidate?.can_apply ||
      nativeSwapSnapshot(candidate.original, a.replacement_id) !==
        nativeSwapSnapshot(a.original, a.replacement_id)
    )
      throw Error(
        "Kit, dates or availability changed. Refresh the replacement choices.",
      );
    if (a.dryRun) return { ok: true, dryRun: true };
    const tile = await ctx.runQuery(
      internal.replyInbox.__service_getThreadById,
      { thread_id: a.thread_id },
    );
    if (!tile?.account_slug || tile.account_slug !== a.original.account_slug)
      throw Error(
        "The rental account changed. Refresh the replacement choices.",
      );
    const basis = {
      account_slug: tile.account_slug,
      hygglo_order_id: a.thread_id,
    };
    const entry = await ctx.runMutation(
      internal.quick_reply_swap_ledger.begin,
      {
        thread_id: a.thread_id,
        request_id: a.request_id,
        snapshot: nativeSwapSnapshot(a.original, a.replacement_id),
      },
    );
    if (entry.state === "applied") return { ok: true, replayed: true };
    if (entry.state !== "new")
      throw Error(
        "This replacement already ran. Check the order before further changes.",
      );
    let out;
    try {
      out = await executeNativeSwap(
        {
          read: () =>
            ctx.runAction(internal.order_edit.__service_getOrderState, basis),
          add: () =>
            ctx.runAction(internal.order_edit.__service_addItem, {
              ...basis,
              product_id: Number(a.replacement_id),
            }),
          remove: (item_id) =>
            ctx.runAction(internal.order_edit.__service_removeItem, {
              ...basis,
              item_id,
            }),
        },
        a.original.item_id,
        Number(a.replacement_id),
      );
    } catch {
      out = {
        ok: false,
        state: "attention",
        message: "Check this order on Hygglo before another replacement.",
      } as const;
    }
    await ctx.runMutation(internal.quick_reply_swap_ledger.finish, {
      id: entry.id,
      state: out.state,
    });
    return out;
  },
});

export const draft = action({
  args: {
    thread_id: v.string(),
    item_index: v.optional(v.number()),
    replacement_id: v.string(),
    basket: v.optional(v.boolean()),
    source: v.optional(v.string()),
    booking_id: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ draft: string }> => {
    await requireOwner(ctx);
    let candidate: any, tile: any, messages: any[];
    if (a.source === "dbcinema_web") {
      if (!a.booking_id) throw Error("Rental unavailable.");
      const [choices, feed, page] = await Promise.all([
        callDbCinema<any>(
          "query",
          a.basket
            ? "rentalReplacements:basketOptions"
            : "rentalReplacements:options",
          {
            bookingId: a.booking_id,
            ...(!a.basket ? { lineIndex: a.item_index ?? 0 } : {}),
          },
        ),
        callDbCinema<any>("query", "rentalChat:adminInbox", {}),
        callDbCinema<any>("query", "rentalChat:messages", {
          bookingId: a.booking_id,
          admin: true,
          paginationOpts: { numItems: 40, cursor: null },
        }),
      ]);
      candidate = choices.options.find((i: any) => i.id === a.replacement_id);
      tile = feed.items?.find((b: any) => b._id === a.booking_id);
      messages = (page.page ?? [])
        .slice()
        .reverse()
        .map((m: any) => ({
          role: m.sender === "owner" ? "owner" : "renter",
          text: m.text,
          at: m.at,
        }));
    } else {
      const choices = a.basket
        ? await nativeBasketOptions(ctx, a.thread_id)
        : await nativeOptions(ctx, a.thread_id, a.item_index ?? 0);
      candidate = choices.options.find((i: any) => i.id === a.replacement_id);
      tile = await ctx.runQuery(internal.replyInbox.__service_getThreadById, {
        thread_id: a.thread_id,
      });
      const thread = await ctx.runQuery(
        internal.hygglo.__service_listByThread,
        { thread_id: a.thread_id },
      );
      messages = thread.slice(-40).map((m: any) => ({
        role: m.role === "owner" ? "owner" : "renter",
        text: m.content,
        at: m.timestamp,
      }));
    }
    if (!candidate?.available || !tile)
      throw Error("Replacement availability changed. Refresh the choices.");
    const base =
        process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app",
      secret = process.env.RENTER_BOT_API_SECRET;
    if (!secret) throw Error("AI reply drafts are not configured.");
    const original = a.basket
      ? candidate.items.map((item: any) => item.replaces).join(", ")
      : (tile.items?.[a.item_index ?? 0]?.name ?? candidate.original.name);
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/dbcinema-chat-draft`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          renter_name: tile.renter_name ?? tile.name,
          booking: { status: tile.status, items: tile.items },
          messages: messages.length
            ? messages
            : [
                {
                  role: "renter",
                  text:
                    tile.preview ?? "Please confirm my requested equipment.",
                  at: Date.now(),
                },
              ],
          replacement: {
            original,
            new_item: a.basket
              ? candidate.items
                  .map((item: any) => `${item.qty}× ${item.name}`)
                  .join(", ")
              : candidate.name,
            available: true,
            price_note: candidate.price_note,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw Error("AI replacement draft is temporarily unavailable.");
    const out = (await response.json()) as { draft: string };
    if (!out.draft?.trim()) throw Error("AI returned an empty draft.");
    return { draft: out.draft.trim() };
  },
});

/** Complete-basket choices: replace every proven unavailable line together. */
async function nativeBasketOptions(ctx: any, thread_id: string): Promise<any> {
  const tile = await ctx.runQuery(internal.replyInbox.__service_getThreadById, {
    thread_id,
  });
  if (
    !tile?.account_slug ||
    !tile.start_date ||
    !tile.end_date ||
    tile.availability?.status !== "conflict"
  )
    return {
      options: [],
      originals: [],
      reason: "No confirmed stock problem was found.",
    };
  const unavailable = tile.items
    .map((item: any, index: number) => ({ item, index }))
    .filter(({ item, index }: any) =>
      tile.availability.items.some(
        (check: any) =>
          check.available === false &&
          (check.item_index === index ||
            (check.item_index == null && check.name === item.name)),
      ),
    );
  if (!unavailable.length || unavailable.length > 8)
    return {
      options: [],
      originals: [],
      reason: "This basket needs an equipment review.",
    };
  const state = tile.has_reservation
    ? await ctx.runAction(internal.order_edit.__service_getOrderState, {
        account_slug: tile.account_slug,
        hygglo_order_id: thread_id,
      })
    : null;
  const originals = unavailable.map(({ item, index }: any) => ({
    name: item.name,
    qty: item.qty,
    image_url:
      item.image_url ??
      tile.requested_items?.find(
        (i: any) => i.origin === "basket" && i.name === item.name,
      )?.image_url ??
      null,
    image_urls: item.image_urls ?? tile.requested_items?.find(
      (i: any) => i.origin === "basket" && i.name === item.name,
    )?.image_urls ?? [],
    item_index: index,
    order_item:(()=>{
      const matches=state?.items?.filter((line:any)=>item.product_id!=null ? line.product_id===item.product_id : line.name===item.name)??[];
      return matches.length===1?matches[0]:null;
    })(),
  }));
  if (
    state &&
    (!state.ok || originals.some((item: any) => !item.order_item?.product_id))
  )
    return {
      options: [],
      originals,
      reason:
        "Refresh the order so every requested item has an exact listing identity.",
    };
  const start=state?.dates?.start??tile.start_date;
  const end=state?.dates?.end??tile.end_date;
  if(state){
    const currentStock=await ctx.runQuery(internal.quick_reply_basket_stock.check,{account_slug:tile.account_slug,thread_id,start,end,lines:state.items.map((item:any)=>({name:item.name,qty:1,...(item.product_id?{product_id:item.product_id}:{})}))});
    if(currentStock.available===true)return {originals,options:[],reason:"The requested kit is now available. Its queue availability will refresh."};
    if(currentStock.available===null)return {originals,options:[],reason:"The current kit needs a stock identity review before a replacement can be offered."};
  }
  const omit = state
    ? originals.map((item: any) => item.order_item.product_id)
    : undefined;
  const groups: any[][] = [];
  for (const original of originals) {
    const result = await ctx.runQuery(
      internal.renter_bot_tools.__service_basket_replacement_candidates,
      {
        account_slug: tile.account_slug,
        item_name: original.name,
        exclude_name: original.name,
        start_date: start,
        end_date: end,
        quantity: original.qty,
        thread_id,
        booking_use: state ? "replacement" : "standalone",
        ...(omit
          ? {
              omit_product_ids: omit,
              basket_lines: state.items.map((item: any) => ({
                name: item.name,
                qty: 1,
                product_id: item.product_id,
              })),
            }
          : {}),
      },
    );
    groups.push(
      (result.alternatives ?? [])
        .filter(
          (item: any) =>
            item.availability?.available === true &&
            item.product_id &&
            item.mapping_complete &&
            !item.storage_contents_verification_required,
        )
        .slice(0, 6),
    );
  }
  const retained = state
    ? state.items
        .filter((line: any) => !omit!.includes(line.product_id))
        .map((line: any) => ({
          name: line.name,
          qty: 1,
          ...(line.product_id ? { product_id: line.product_id } : {}),
        }))
    : tile.items
        .filter(
          (_: any, index: number) =>
            !unavailable.some((item: any) => item.index === index),
        )
        .map((item: any) => ({ name: item.name, qty: item.qty }));
  const { sets, limited } = await replacementSets(
    groups,
    (item: any) => String(item.product_id),
    async (set: any[]) => {
      const result = await ctx.runQuery(
        internal.quick_reply_basket_stock.check,
        {
          account_slug: tile.account_slug,
          thread_id,
          start,
          end,
          lines: [
            ...retained,
            ...set.map((item, index) => ({
              name: item.name,
              qty: originals[index].qty,
              product_id: item.product_id,
              item_id: item.item_id,
            })),
          ],
        },
      );
      return result.available === true;
    },
  );
  const listings = sets.length
    ? await ctx.runQuery(internal.online_listings.__service_list, {
        account_slug: tile.account_slug,
      })
    : [];
  const original = {
    account_slug: tile.account_slug,
    start: state?.dates?.start ?? tile.start_date,
    end: state?.dates?.end ?? tile.end_date,
    items: state?.items ?? tile.items,
  };
  return {
    originals,
    options: sets.map((set: any[], index: number) => ({
      id: set.map((item: any) => String(item.product_id)).join("|"),
      name: `Replacement set ${index + 1}`,
      image_url: null,
      available: true,
      original,
      items: set.map((item: any, i: number) => ({
        id: String(item.product_id),
        name:
          item.listing_name ??
          listings.find(
            (listing: any) => listing.product_id === item.product_id,
          )?.display_name ??
          item.name,
        image_url:
          listings.find(
            (listing: any) => listing.product_id === item.product_id,
          )?.image ??
          item.image_url ??
          null,
        image_urls: [...new Set([
          listings.find((listing: any) => listing.product_id === item.product_id)?.image,
          item.image_url,
        ].filter((url): url is string => typeof url === "string" && !!url))],
        qty: originals[i].qty,
        replaces: originals[i].name,
        old_item_id: originals[i].order_item?.item_id ?? null,
      })),
      can_apply: !!(
        state?.actions?.add_product &&
        originals.every(
          (item: any) =>
            item.order_item?.can_remove &&
            Number.isSafeInteger(item.order_item.item_id) &&
            item.qty === 1,
        )
      ),
      price_note:
        "This set was checked together with the retained kit. Hygglo recalculates the order price; review it before sending.",
    })),
    reason: sets.length
      ? null
      : limited
        ? "No complete set found within the bounded search. Review the equipment manually."
        : "No compatible complete set with verified stock was found.",
  };
}
export const basketOptions = action({
  args: { thread_id: v.string() },
  handler: async (ctx, a): Promise<any> => {
    await requireOwner(ctx);
    return nativeBasketOptions(ctx, a.thread_id);
  },
});
export const acceptBasket = action({
  args: {
    thread_id: v.string(),
    replacement_id: v.string(),
    original: v.any(),
    request_id: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<any> => {
    await requireOwner(ctx);
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(a.request_id))
      throw Error("Invalid replacement request.");
    const snapshot = basketSwapSnapshot(a.original, a.replacement_id);
    const prior = await ctx.runQuery(internal.quick_reply_swap_ledger.receipt, {
      request_id: a.request_id,
    });
    if (prior) {
      if (prior.thread_id !== a.thread_id || prior.snapshot !== snapshot)
        throw Error("Replacement request changed.");
      if (prior.state === "applied") return { ok: true, replayed: true };
      throw Error(
        "This operation already ran. Check the complete order before another change.",
      );
    }
    const fresh = await nativeBasketOptions(ctx, a.thread_id);
    const candidate = fresh.options.find(
      (option: any) => option.id === a.replacement_id,
    );
    if (
      !candidate?.can_apply ||
      basketSwapSnapshot(candidate.original, a.replacement_id) !== snapshot
    )
      throw Error(
        "The kit, dates or stock changed. Refresh the replacement sets.",
      );
    if (a.dryRun) return { ok: true, dryRun: true };
    const entry = await ctx.runMutation(
      internal.quick_reply_swap_ledger.begin,
      { thread_id: a.thread_id, request_id: a.request_id, snapshot },
    );
    if (entry.state !== "new")
      throw Error(
        "This operation already started. Check the order before another change.",
      );
    const basis = {
      account_slug: candidate.original.account_slug,
      hygglo_order_id: a.thread_id,
    };
    let result;
    try {
      result = await executeNativeBasketSwap(
        {
          read: () =>
            ctx.runAction(internal.order_edit.__service_getOrderState, basis),
          add: (product_id) =>
            ctx.runAction(internal.order_edit.__service_addItem, {
              ...basis,
              product_id,
            }),
          remove: (item_id) =>
            ctx.runAction(internal.order_edit.__service_removeItem, {
              ...basis,
              item_id,
            }),
        },
        candidate.items.map((item: any) => ({
          oldId: item.old_item_id,
          newProductId: Number(item.id),
        })),
        candidate.original,
      );
    } catch {
      result = {
        ok: false,
        state: "attention" as const,
        message:
          "The result could not be verified. Check the complete order on Hygglo.",
      };
    }
    await ctx.runMutation(internal.quick_reply_swap_ledger.finish, {
      id: entry.id,
      state: result.state,
    });
    return result;
  },
});
