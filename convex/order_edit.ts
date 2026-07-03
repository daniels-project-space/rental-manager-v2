"use node";
/**
 * Order-edit actions (2026-07-03) — the Reply-Inbox "edit this booking" surface.
 *
 * Lets the operator, from the dashboard chat, do what Hygglo's own owner order
 * page does: add / remove items, change the rental price (discount or increase),
 * and change the dates — all on ONE order, live, through the same action
 * dispatcher (`PATCH /v4/my/orders/{id}` `{action,data}`).
 *
 * READS here (getOrderState / previewPrice / itemUnavailableDates) do their own
 * authed GET — same pattern as convex/renter_trust.ts — reading the payload
 * defensively (Hygglo's order shape is loose + version-dependent). WRITES go
 * through the single chokepoint src/lib/hygglo-write.ts (gated by
 * ALLOW_MANUAL_ORDER_ACTIONS; deliberate clicks only, never a cron).
 *
 * Every write respects `dryRun` (Reply Inbox "Test mode") — it returns
 * {status:"sent", reason:"DRY_RUN"} without touching Hygglo, so the whole flow
 * is exercisable safely.
 *
 * VERB SELECTION IS ORDER-STATE-DRIVEN. The date verb (changeDates vs
 * selectDates) and the discount verb (changePrice vs partialRefund) depend on
 * the order's `actions` map — the UI reads getOrderState().actions and passes
 * the right one; the write helpers default sensibly if omitted.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";
import {
  addOrderProduct,
  removeOrderItem,
  changeOrderPrice,
  partialRefundOrder,
  changeOrderDates,
} from "../src/lib/hygglo-write";

const TZ = "Europe/London";

// ── Loose order-detail shape (read defensively) ───────────────────
interface RawAmount {
  amount?: number;
  amountLabel?: string;
  label?: string;
}
interface RawItem {
  name?: string;
  type?: string;
  itemId?: number;
  productId?: number;
  slug?: string;
  image?: { fullSizeUrl?: string; thumbnailUrl?: string };
  actions?: { remove?: boolean };
  price?: { label?: string };
  priceRange?: { label?: string };
}
interface RawOrder {
  id?: number;
  currency?: string;
  rentalPeriod?: { startDateUTC?: string; endDateUTC?: string };
  price?: {
    currency?: string;
    breakdown?: {
      orderPrice?: RawAmount;
      serviceFee?: RawAmount;
      totalPrice?: RawAmount;
      lenderEarnings?: RawAmount;
    };
  };
  items?: RawItem[];
  steps?: Array<{ key?: string; active?: boolean; completed?: boolean }>;
  actions?: Record<string, boolean>;
  users?: { otherPart?: { name?: string } };
}

/** ISO UTC-midnight → yyyy-MM-dd (the wire format both date verbs expect). */
function isoToDay(iso?: string): string | null {
  if (!iso || typeof iso !== "string") return null;
  return iso.slice(0, 10);
}

async function tokenFor(accountSlug: string): Promise<string> {
  const creds = await getAccountCredentials(accountSlug);
  return getHyggloAccessToken({ ...creds, accountSlug });
}

async function fetchOrder(
  accountSlug: string,
  orderId: string,
): Promise<RawOrder> {
  const token = await tokenFor(accountSlug);
  const res = await fetch(
    `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(orderId)}?timezone=${TZ}`,
    { headers: hyggloAuthHeaders(token) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`order ${orderId} fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RawOrder;
}

// ── Normalised editing view ───────────────────────────────────────

export type OrderEditState = {
  ok: boolean;
  order_id: string;
  renter_name: string | null;
  currency: string;
  dates: { start: string | null; end: string | null };
  price: {
    order_price: number | null; // the editable rental amount (before service fee)
    total: number | null; // renter-facing total
    earnings: number | null; // owner earnings
  };
  items: Array<{
    item_id: number | null;
    product_id: number | null;
    name: string;
    image: string | null;
    thumb: string | null;
    can_remove: boolean;
    price_label: string | null;
  }>;
  actions: {
    add_product: boolean;
    remove_item: boolean;
    change_price: boolean;
    change_dates: boolean;
    select_dates: boolean;
    partial_refund: boolean;
  };
  step: string | null;
  error?: string;
};

/**
 * Live editing view of one order (items + price + dates + which edits Hygglo
 * currently allows in this state). Read-only — always safe.
 */
export const getOrderState = action({
  args: { account_slug: v.string(), hygglo_order_id: v.string() },
  handler: async (_ctx, { account_slug, hygglo_order_id }): Promise<OrderEditState> => {
    try {
      const o = await fetchOrder(account_slug, hygglo_order_id);
      const bd = o.price?.breakdown ?? {};
      const a = o.actions ?? {};
      const activeStep = (o.steps ?? []).find((s) => s.active)?.key ?? null;
      const items = (o.items ?? [])
        // Only real product line-items are editable (skip insurance/fee rows).
        .filter((it) => (it.type ?? "PRODUCT") === "PRODUCT")
        .map((it) => ({
          item_id: it.itemId ?? null,
          product_id: it.productId ?? null,
          name: it.name ?? "Item",
          image: it.image?.fullSizeUrl ?? it.image?.thumbnailUrl ?? null,
          thumb: it.image?.thumbnailUrl ?? it.image?.fullSizeUrl ?? null,
          can_remove: it.actions?.remove === true,
          price_label: it.price?.label ?? it.priceRange?.label ?? null,
        }));
      return {
        ok: true,
        order_id: String(o.id ?? hygglo_order_id),
        renter_name: o.users?.otherPart?.name?.trim() || null,
        currency: o.price?.currency ?? o.currency ?? "GBP",
        dates: {
          start: isoToDay(o.rentalPeriod?.startDateUTC),
          end: isoToDay(o.rentalPeriod?.endDateUTC),
        },
        price: {
          order_price: bd.orderPrice?.amount ?? null,
          total: bd.totalPrice?.amount ?? null,
          earnings: bd.lenderEarnings?.amount ?? null,
        },
        items,
        actions: {
          add_product: a.addProduct === true,
          remove_item: a.removeItem === true,
          change_price: a.changePrice === true,
          change_dates: a.changeDates === true,
          select_dates: a.selectDates === true,
          partial_refund: a.partialRefund === true,
        },
        step: activeStep,
      };
    } catch (err) {
      return {
        ok: false,
        order_id: hygglo_order_id,
        renter_name: null,
        currency: "GBP",
        dates: { start: null, end: null },
        price: { order_price: null, total: null, earnings: null },
        items: [],
        actions: {
          add_product: false,
          remove_item: false,
          change_price: false,
          change_dates: false,
          select_dates: false,
          partial_refund: false,
        },
        step: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

/**
 * Preview the renter-facing total for a proposed new rental price (before
 * committing changePrice). Read-only. Returns the calculator's old/new prices.
 */
export const previewPrice = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    new_order_price: v.number(),
  },
  handler: async (
    _ctx,
    { account_slug, hygglo_order_id, new_order_price },
  ): Promise<{
    ok: boolean;
    old_order_price?: number;
    old_total?: number;
    new_order_price?: number;
    new_total?: number;
    error?: string;
  }> => {
    try {
      const token = await tokenFor(account_slug);
      const res = await fetch(
        `${HYGGLO_API_BASE}/v4/my/order-price-change-calculator/${encodeURIComponent(hygglo_order_id)}?newOrderPrice=${encodeURIComponent(String(new_order_price))}`,
        { headers: hyggloAuthHeaders(token) },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `preview ${res.status}: ${body.slice(0, 160)}` };
      }
      const j = (await res.json()) as {
        oldPrices?: { orderPrice?: number; orderTotal?: number };
        newPrices?: { orderPrice?: number; orderTotal?: number };
      };
      return {
        ok: true,
        old_order_price: j.oldPrices?.orderPrice,
        old_total: j.oldPrices?.orderTotal,
        new_order_price: j.newPrices?.orderPrice,
        new_total: j.newPrices?.orderTotal,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

/**
 * Union of unavailable (blocked/booked) dates across the order's item listings,
 * for the in-manager date picker. Best-effort — a fetch failure returns [] so
 * the picker still works (just without greying-out). Each date is yyyy-MM-dd.
 */
export const itemUnavailableDates = action({
  args: { account_slug: v.string(), hygglo_order_id: v.string() },
  handler: async (
    _ctx,
    { account_slug, hygglo_order_id },
  ): Promise<{ dates: string[]; min_rental_days: number }> => {
    try {
      const token = await tokenFor(account_slug);
      const order = await fetchOrder(account_slug, hygglo_order_id);
      const productIds = [
        ...new Set(
          (order.items ?? [])
            .map((it) => it.productId)
            .filter((x): x is number => typeof x === "number"),
        ),
      ];
      const out = new Set<string>();
      let minDays = 1;
      for (const pid of productIds) {
        try {
          const res = await fetch(
            `${HYGGLO_API_BASE}/v2/my/products/${pid}`,
            { headers: hyggloAuthHeaders(token) },
          );
          if (!res.ok) continue;
          const p = (await res.json()) as {
            minimumRentalDays?: number;
            unavailableDates?: unknown[];
          };
          if (typeof p.minimumRentalDays === "number")
            minDays = Math.max(minDays, p.minimumRentalDays);
          for (const d of p.unavailableDates ?? []) {
            // Hygglo mixes "yyyy-MM-dd" strings and { date } / { from,to } objects.
            if (typeof d === "string") out.add(d.slice(0, 10));
            else if (d && typeof d === "object") {
              const obj = d as { date?: string; from?: string; to?: string };
              if (obj.date) out.add(obj.date.slice(0, 10));
              if (obj.from) out.add(obj.from.slice(0, 10));
            }
          }
        } catch {
          /* skip this product's blocked dates */
        }
      }
      return { dates: [...out].sort(), min_rental_days: minDays };
    } catch {
      return { dates: [], min_rental_days: 1 };
    }
  },
});

// ── Writes (each honours dryRun) ──────────────────────────────────

type WriteOut = {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  httpStatus?: number;
  error?: string;
};

/** Add a listing (by catalog productId) to the order. */
export const addItem = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    product_id: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<WriteOut> => {
    if (a.dryRun) return { status: "sent", reason: "DRY_RUN" };
    return addOrderProduct({
      accountSlug: a.account_slug,
      hyggloOrderId: a.hygglo_order_id,
      productId: a.product_id,
    });
  },
});

/** Remove an order line-item (by its order itemId) from THIS order only. */
export const removeItem = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    item_id: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<WriteOut> => {
    if (a.dryRun) return { status: "sent", reason: "DRY_RUN" };
    return removeOrderItem({
      accountSlug: a.account_slug,
      hyggloOrderId: a.hygglo_order_id,
      itemId: a.item_id,
    });
  },
});

/**
 * Set a new rental price (the editable orderPrice — Hygglo recomputes the total
 * + earnings). Used for BOTH a discount and an increase. Pre-payment path.
 */
export const setPrice = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    order_price: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<WriteOut> => {
    if (a.order_price < 0) return { status: "failed", error: "price must be ≥ 0" };
    if (a.dryRun) return { status: "sent", reason: "DRY_RUN" };
    return changeOrderPrice({
      accountSlug: a.account_slug,
      hyggloOrderId: a.hygglo_order_id,
      price: a.order_price,
    });
  },
});

/** Post-payment discount: refund an amount to the renter (partialRefund). */
export const refund = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    amount: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<WriteOut> => {
    if (a.amount <= 0) return { status: "failed", error: "refund must be > 0" };
    if (a.dryRun) return { status: "sent", reason: "DRY_RUN" };
    return partialRefundOrder({
      accountSlug: a.account_slug,
      hyggloOrderId: a.hygglo_order_id,
      refund: a.amount,
    });
  },
});

/**
 * Change the rental dates. `verb` comes from getOrderState().actions —
 * "changeDates" for an accepted order, "selectDates" for a pending request.
 * Both dates are yyyy-MM-dd.
 */
export const setDates = action({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    start: v.string(),
    end: v.string(),
    verb: v.optional(
      v.union(v.literal("changeDates"), v.literal("selectDates")),
    ),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<WriteOut> => {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(a.start) || !day.test(a.end))
      return { status: "failed", error: "dates must be yyyy-MM-dd" };
    if (a.end < a.start)
      return { status: "failed", error: "end date is before start date" };
    if (a.dryRun) return { status: "sent", reason: "DRY_RUN" };
    return changeOrderDates({
      accountSlug: a.account_slug,
      hyggloOrderId: a.hygglo_order_id,
      rentalStartDate: a.start,
      rentalEndDate: a.end,
      verb: a.verb,
    });
  },
});
