/**
 * Inquiry listing context (2026-06-27).
 *
 * A Hygglo inquiry is started FROM a specific listing, and the order detail
 * (GET /v4/my/orders/{id}) always carries `items[]` (the listing the renter
 * clicked "ask owner" on) — but for date-less inquiries no reservation row is
 * built, so the poller dropped them and the draft had NO idea what listing the
 * renter meant ("the AI doesn't know what listing there is"). This resolver
 * snapshots the order's items onto conversations.inquiry_items (with product_id)
 * so getThreadContext can name + GROUND the listing (specs / price / owned).
 */
import { action, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const TZ = "Europe/London";

export const ctxInput = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (!conv) return null;
    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    const account_slug = conv.account_slug ?? reservation?.account_slug ?? null;
    return {
      conv_id: conv._id,
      account_slug,
      has_reservation: !!reservation,
      already: (conv.inquiry_items ?? []).length > 0,
    };
  },
});

export const setInquiryItems = internalMutation({
  args: {
    conv_id: v.id("conversations"),
    items: v.array(
      v.object({
        name: v.string(),
        qty: v.number(),
        image_url: v.optional(v.string()),
        product_id: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { conv_id, items }) => {
    await ctx.db.patch(conv_id, {
      inquiry_items: items,
      inquiry_image_url: items.find((i) => i.image_url)?.image_url,
    });
  },
});

async function fetchOrderItems(
  accountSlug: string,
  hyggloOrderId: string,
): Promise<{ name: string; qty: number; image_url?: string; product_id?: number }[]> {
  try {
    const creds = await getAccountCredentials(accountSlug);
    const token = await getHyggloAccessToken({ ...creds, accountSlug });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(hyggloOrderId)}?timezone=${encodeURIComponent(TZ)}`,
      { headers: hyggloAuthHeaders(token) },
    );
    if (!res.ok) return [];
    const d = (await res.json()) as { items?: any[] };
    return (d.items ?? [])
      .map((i) => ({
        name: String(i?.name ?? i?.title ?? "").trim(),
        qty: Number(i?.quantity ?? i?.qty ?? 1) || 1,
        product_id:
          typeof i?.productId === "number"
            ? i.productId
            : typeof i?.product?.id === "number"
              ? i.product.id
              : undefined,
        image_url:
          i?.image?.thumbnailUrl ??
          i?.images?.[0]?.thumbnailUrl ??
          i?.images?.[0]?.fullSizeUrl ??
          undefined,
      }))
      .filter((x) => x.name.length > 0);
  } catch {
    return [];
  }
}

/** Capture the inquiry's listing onto conv.inquiry_items (no-reservation only —
 *  reservations already carry hygglo_items). */
export const resolveForThread = action({
  args: { thread_id: v.string(), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { thread_id, force },
  ): Promise<{ ok: boolean; count?: number; reason?: string }> => {
    const inp = await ctx.runQuery(internal.inquiry_context.ctxInput, { thread_id });
    if (!inp || !inp.account_slug) return { ok: false, reason: "no conversation" };
    if (inp.has_reservation) return { ok: true, reason: "has reservation" };
    if (inp.already && !force) return { ok: true, reason: "cached" };
    const items = await fetchOrderItems(inp.account_slug, thread_id);
    if (!items.length) return { ok: false, reason: "no items" };
    await ctx.runMutation(internal.inquiry_context.setInquiryItems, {
      conv_id: inp.conv_id,
      items,
    });
    return { ok: true, count: items.length };
  },
});

/** Renter-last inquiry threads (no reservation) with no listing snapshot yet. */
export const threadsNeedingListing = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .take(400);
    const out: string[] = [];
    for (const conv of convs) {
      if ((conv.inquiry_items ?? []).length > 0) continue;
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", conv.thread_id))
        .first();
      if (!reservation) out.push(conv.thread_id);
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Cron: backfill inquiry listings, capped per run. */
export const resolveActive = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ resolved: number }> => {
    const threads = await ctx.runQuery(internal.inquiry_context.threadsNeedingListing, {
      limit: limit ?? 30,
    });
    let resolved = 0;
    for (const t of threads) {
      const r = await ctx.runAction(api.inquiry_context.resolveForThread, {
        thread_id: t,
      });
      if (r.ok && r.count) resolved++;
    }
    return { resolved };
  },
});
