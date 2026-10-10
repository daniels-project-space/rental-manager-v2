"use node";
import { action, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { callDbCinema } from "./dbcinema_chat";
import { executeNativeSwap, nativeSwapSnapshot } from "./lib/quick_reply_swap";

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
    internal.renter_bot_tools.__service_find_owned_alternatives,
    {
      account_slug: tile.account_slug,
      item_name: item.name,
      exclude_name: item.name,
      start_date: tile.start_date,
      end_date: tile.end_date,
      quantity: item.qty,
      thread_id,
      lens_requirements: {},
      camera_requirements: {},
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
    await requireOwner(ctx, true);
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
    await requireOwner(ctx, true);
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
    item_index: v.number(),
    replacement_id: v.string(),
    source: v.optional(v.string()),
    booking_id: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ draft: string }> => {
    await requireOwner(ctx, true);
    let candidate: any, tile: any, messages: any[];
    if (a.source === "dbcinema_web") {
      if (!a.booking_id) throw Error("Rental unavailable.");
      const [choices, feed, page] = await Promise.all([
        callDbCinema<any>("query", "rentalReplacements:options", {
          bookingId: a.booking_id,
          lineIndex: a.item_index,
        }),
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
      const choices = await nativeOptions(ctx, a.thread_id, a.item_index);
      candidate = choices.options.find((i: any) => i.id === a.replacement_id);
      tile = await ctx.runQuery(internal.replyInbox.__service_getThreadById, {
        thread_id: a.thread_id,
      });
      const thread = await ctx.runQuery(
        internal.hygglo.__service_listByThread,
        { thread_id: a.thread_id },
      );
      messages = thread
        .slice(-40)
        .map((m: any) => ({
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
    const original =
      tile.items?.[a.item_index]?.name ?? candidate.original.name;
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
            new_item: candidate.name,
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
