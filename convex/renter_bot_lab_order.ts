import { friendBasketReply, verificationFailureReply } from "./lib/verification_failure";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortItemName } from "./lib/item_display_name";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { baseListingProductIds } from "./lib/base_listing_identity";
import { bestMatch, isGenericItemQuery } from "./lib/item_name_match";
import type { PriceTier } from "./lib/hygglo_pricing";
import { inclusiveDays, summarise } from "./lib/renter_order_quote";
export { inclusiveDays, summarise } from "./lib/renter_order_quote";
import { checkRentalStock, validIsoDate } from "./lib/renter_stock";
import { checkOrderRentalStock } from "./lib/renter_order_stock";
import { getBotBooking, getLabOrder } from "./lib/renter_booking";
import { draftContextKey } from "./lib/draft_review";
import type { QueryCtx } from "./_generated/server";
import { rentalStage } from "./lib/rental_stage";
import { recentThreadMessages } from "./lib/thread_messages";
import { londonToday } from "./lib/effectiveDates";

async function amendmentContext(ctx: QueryCtx, threadId: string) {
  const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", threadId)).first();
  return draftContextKey(await getBotBooking(ctx, threadId), conv?.inquiry_items, await getLabOrder(ctx, threadId));
}

/**
 * The SIMULATED Hygglo order behind a Renter Bot Lab session.
 *
 * Purpose: let the bot actually add items, drop items and move dates in chat —
 * the same things a renter can do on Hygglo — so its item resolution and its
 * arithmetic can be watched, instead of being taken on trust from prose. It
 * also removes a dead end that was producing real failures: with no way to act
 * on "yes please, add it", the bot could only ask the renter to confirm again,
 * or claim an action it had not performed and be blocked by the guard.
 *
 * SAFETY: every entry point here refuses a thread id that is not `__probe__`.
 * Nothing in this file touches hygglo_messages, reservations, calendar_holds
 * or any send path. A real booking cannot be reached from here.
 */

export const LAB_PREFIX = "__probe__";

function assertLabThread(threadId: string) {
  if (!threadId.startsWith(LAB_PREFIX)) {
    throw new Error(
      "renter_bot_lab_order only operates on Lab/probe threads — refusing a real conversation",
    );
  }
}

/**
 * Hygglo counts rental days INCLUSIVELY: a pickup and return on the same date
 * is 1 day, and 23rd→24th is 2. Getting this wrong understates every total.
 */
type OrderLine = {
  display_name?: string;
  product_id?: number;
  item_id?: string;
  name: string;
  qty: number;
  daily_price_gbp?: number;
  pricing_basis?: "listing" | "catalog";
  price_tiers?: PriceTier[];
  origin: string;
};

/** Line totals + grand total, so the Lab and the bot quote the same numbers. */

/**
 * Daily price for one item on one account: its own listing (cheapest), else
 * the curated catalog. Identity-first, override ∪ index — the same order
 * lookup_pricing and find_owned_alternatives use, so the Lab panel, the tools
 * and the draft cannot quote three different numbers for one item.
 */
/** The listing id an item is priced from on this account (cheapest wins). */
async function listingPidForItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  itemId: string,
): Promise<number | undefined> {
  const listings = await ctx.db
    .query("online_listings")
    .withIndex("by_account", (q: { eq: (a: string, b: string) => unknown }) =>
      q.eq("account_slug", accountSlug),
    )
    .collect();
  const idx = await ctx.db.query("hygglo_product_index").collect();
  const ov = await ctx.db.query("listing_resolution_override").collect();
  const inventory = await ctx.db.query("items").collect();
  const pids = baseListingProductIds(accountSlug, itemId, idx, ov, inventory);
  let best: { pid: number; price: number } | null = null;
  for (const pid of pids) {
    const l = listings.find((x: { product_id: number }) => x.product_id === pid) as
      | { daily_price?: number }
      | undefined;
    if (typeof l?.daily_price !== "number") continue;
    if (!best || l.daily_price < best.price || (l.daily_price === best.price && pid < best.pid)) best = { pid, price: l.daily_price };
  }
  return best?.pid;
}

async function resolveDailyPrice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  itemId: string,
  itemName: string,
): Promise<number | undefined> {
  const listings = await ctx.db
    .query("online_listings")
    .withIndex("by_account", (q: { eq: (a: string, b: string) => unknown }) =>
      q.eq("account_slug", accountSlug),
    )
    .collect();
  const idx = await ctx.db.query("hygglo_product_index").collect();
  const ov = await ctx.db.query("listing_resolution_override").collect();
  const inventory = await ctx.db.query("items").collect();
  const pids = baseListingProductIds(accountSlug, itemId, idx, ov, inventory);
  let price: number | undefined;
  for (const pid of pids) {
    const l = listings.find((x: { product_id: number }) => x.product_id === pid) as
      | { daily_price?: number }
      | undefined;
    if (typeof l?.daily_price === "number" && (price === undefined || l.daily_price < price))
      price = l.daily_price;
  }
  if (price === undefined) {
    const cat = await ctx.db.query("pricing_catalog").collect();
    const hit = cat.filter(
      (c: { item_name_canonical: string; marketing_only?: boolean; is_bundle?: boolean; daily_price_min:number }) =>
        !c.marketing_only && !c.is_bundle && c.daily_price_min > 0 &&
        c.item_name_canonical.toLowerCase().trim() === itemName.toLowerCase().trim(),
    ).sort((a: {daily_price_min:number}, b: {daily_price_min:number}) => a.daily_price_min-b.daily_price_min)[0] as { daily_price_min?: number } | undefined;
    price = hit?.daily_price_min;
  }
  return price;
}


/** Hygglo's tier table for a listing, from the daily-synced catalog cache. */
async function tiersForProduct(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  productId: number,
): Promise<PriceTier[] | undefined> {
  const hp = await ctx.db
    .query("hygglo_products")
    .withIndex("by_account_product", (q: { eq: (a: string, b: unknown) => unknown }) =>
      (q as unknown as { eq: (a: string, b: unknown) => { eq: (c: string, d: unknown) => unknown } })
        .eq("accountSlug", accountSlug)
        .eq("productId", productId),
    )
    .unique();
  const rows = (hp?.prices ?? []) as PriceTier[];
  return rows.length ? rows.map((r) => ({ days: r.days, pricePerDay: r.pricePerDay })) : undefined;
}

export const get = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const row = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .unique();
    if (!row) return null;
    const display = await listingDisplayCatalog(ctx, row.account_slug);
    const booking = await getBotBooking(ctx, thread_id);
    const referral = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", thread_id)).unique();
    return {
      ...summarise(
        row.items.map((i) => ({ ...i, display_name: i.product_id != null ? display.name(row.account_slug, i.product_id, i.name) : i.item_id ? shortItemName(display.itemMap.get(String(i.item_id)) ?? i.name) : shortItemName(i.name), item_id: i.item_id ? String(i.item_id) : undefined })),
        row.start_date,
        row.end_date,
      ),
      changes: row.changes,
      stage: rentalStage(booking, londonToday()).stage,
      referral_code: referral?.code,
      account_slug: row.account_slug,
    };
  },
});

/** Create/reset the simulated order when a Lab session starts. */
export const seed = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    item_names: v.array(v.string()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
    /**
     * The Hygglo listing the renter is actually looking at.
     *
     * A renter books a LISTING at the listing's price, not a basket of item
     * rates. Seeding from item names priced the BMPCC 6K Pro at £35 — the
     * cheapest body-only listing — even when the scenario represented a set
     * that really costs more. Quoting an item rate for a set understates what
     * the renter pays, which is the one number they care about.
     */
    base_product_id: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    const existing = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .unique();
    if (await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", a.thread_id)).unique())
      throw new Error("A referred cancelled basket is immutable; start a new Lab session");
    if (existing) await ctx.db.delete(existing._id);

    const owned = (await ctx.db.query("items").collect()).filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    const lines = [];
    if (a.base_product_id != null) {
      const listing = await ctx.db
        .query("online_listings")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", a.account_slug).eq("product_id", a.base_product_id as number),
        )
        .unique();
      if (listing) {
        lines.push({
          item_id: undefined,
          product_id: a.base_product_id,
          // The listing IS the line, exactly as on Hygglo.
          name: (listing.name ?? "listing").slice(0, 70),
          qty: 1,
          daily_price_gbp: listing.daily_price,
          pricing_basis: "listing" as const,
          price_tiers: await tiersForProduct(ctx, a.account_slug, a.base_product_id as number),
          origin: "listing",
        });
      }
    }
    for (const name of lines.length ? [] : a.item_names) {
      const m = bestMatch(name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      const hit = m.match && m.confident ? m.match : null;
      const pricedPid = hit ? await listingPidForItem(ctx, a.account_slug, String(hit._id)) : undefined;
      // Price the SEEDED items too. Leaving them undefined made total_gbp null
      // for every scenario, so the bot was told "do not quote a total" on a
      // perfectly ordinary booking and the Lab panel could never show one.
      lines.push({
        item_id: hit ? hit._id : undefined,
        name: hit ? hit.name_canonical : name,
        qty: 1,
        daily_price_gbp: hit
          ? await resolveDailyPrice(ctx, a.account_slug, String(hit._id), hit.name_canonical)
          : undefined,
        pricing_basis: pricedPid != null ? "listing" as const : "catalog" as const,
        price_tiers: pricedPid != null ? await tiersForProduct(ctx, a.account_slug, pricedPid) : undefined,
        origin: "seed",
      });
    }
    await ctx.db.insert("renter_bot_lab_orders", {
      thread_id: a.thread_id,
      account_slug: a.account_slug,
      items: lines,
      start_date: a.start_date,
      end_date: a.end_date,
      changes: [],
      updated_at: Date.now(),
    });
    return { seeded: lines.length };
  },
});

/**
 * Apply one booking change. Called by the agent's `modify_booking` tool.
 *
 * Item resolution goes through the shared confident matcher, so "the 100mm
 * anamorphic" has to land on a real inventory row or the change is refused —
 * the bot cannot add something we do not own, and cannot silently add the
 * wrong thing.
 */
export const applyChange = mutation({
  args: {
    thread_id: v.string(),
    action: v.union(
      v.literal("add_item"),
      v.literal("remove_item"),
      v.literal("set_dates"),
    ),
    preview_only: v.optional(v.boolean()),
    /** Bound by the canonical server tool scope, never chosen by the model. */
    request_message_id: v.optional(v.string()),
    item_name: v.optional(v.string()),
    qty: v.optional(v.number()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    if (a.preview_only && a.action !== "add_item") return {ok:false,error:"Read-only proposals only support adding one exact item."};
    const row = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .unique();
    if (!row) return { ok: false, error: "no simulated order for this session" };

    const [latestMessage] = await recentThreadMessages(ctx, a.thread_id, 1);
    if (a.request_message_id !== undefined && a.request_message_id !== latestMessage?.message_id)
      return { ok:false, error_code:"stale_inbound", error:"A newer message arrived. No booking changes were made; regenerate using the current conversation." };
    const messageId = a.request_message_id ?? latestMessage?.message_id;
    const nativeItems = a.action === "set_dates" ? [] : await ctx.db.query("items").collect();
    const identity = a.item_name ? bestMatch(a.item_name, nativeItems, i=>i.name_canonical, i=>i.aliases ?? []) : null;
    const itemKey = identity?.confident && identity.match ? String(identity.match._id) : a.item_name?.trim().toLowerCase();
    const requestKey = messageId && !a.preview_only ? JSON.stringify([messageId,a.action,
      ...(a.action === "set_dates" ? [a.start_date,a.end_date ?? a.start_date] : [itemKey,a.qty ?? 1])]) : undefined;
    const previous = requestKey ? row.changes.find(change => change.request_key === requestKey) : undefined;
    if (previous) return {ok:true,already_applied:true,action_performed:false,previous_change_summary:previous.summary,
      note:"This request was applied previously. NO new edit was made. Describe the CURRENT order below, using already set to or already contains where appropriate; never say I moved, added or removed it this time. A later edit may have changed the order since that earlier action.",
      order:summarise(row.items,row.start_date,row.end_date)};

    const beforeContext = await amendmentContext(ctx, a.thread_id);
    const beforeRevision = row.changes.length;
    const transition = async () => ({ source: "native_lab_amendment" as const,
      thread_id: a.thread_id, before_context_key: beforeContext,
      after_context_key: await amendmentContext(ctx, a.thread_id),
      before_revision: beforeRevision, after_revision: beforeRevision + 1 });

    const lines: OrderLine[] = row.items.map((i) => ({
      ...i,
      item_id: i.item_id ? String(i.item_id) : undefined,
    }));
    let summaryText = "";
    const booking = await getBotBooking(ctx, a.thread_id);
    const stage = rentalStage(booking, londonToday()).stage;
    if (booking?.return_date || ["COMPLETED", "CANCELLED", "VERIFICATION_FAILED"].includes(stage))
      return { ok: false, error: "This rental is already closed. Arrange a new booking instead of changing its dates or items." };

    if (a.action === "set_dates") {
      if (!a.start_date) return { ok: false, error: "start_date required" };
      const end = a.end_date ?? a.start_date;
      if (!validIsoDate(a.start_date) || !validIsoDate(end) || end < a.start_date || inclusiveDays(a.start_date, end) > 366)
        return { ok: false, error: "Use valid pickup and return dates in order, up to 366 rental days" };
      if ((booking?.pickup_date || booking?.status === "ongoing") && a.start_date !== row.start_date)
        return { ok: false, error: "The rental has already been collected. Keep its original pickup date when extending the return." };
      if (a.start_date === row.start_date && end === row.end_date)
        return {ok:true,already_applied:true,action_performed:false,unchanged:true,
          note:"The booking already has these dates. No new edit occurred. Say the dates are already set, not that you moved or changed them.",
          order:summarise(lines,row.start_date,row.end_date)};
      const stock = await checkOrderRentalStock(ctx, row.account_slug, lines, a.start_date, end, a.thread_id);
      if (stock.available !== true) return { ok: false, error_code: "stock_unavailable_or_unknown",
        error: `Cannot change this basket to ${a.start_date} – ${end}: ${stock.reason}. No dates or prices were changed. Use the checked full date span for the refusal; a failed range check alone does not prove which individual day is booked.`, stock_receipts: stock.receipts };
      await ctx.db.patch(row._id, {
        start_date: a.start_date,
        end_date: end,
        changes: [
          ...row.changes,
          { at: Date.now(), summary: `dates -> ${a.start_date} to ${end}`, ...(requestKey ? {request_key:requestKey} : {}) },
        ],
        updated_at: Date.now(),
      });
      if (booking) await ctx.db.patch(booking._id, {
        start_date: a.start_date,
        end_date: end,
      });
      return {
        ok: true,
        action_performed: true,
        applied: `dates set to ${a.start_date} – ${end}`,
        order: summarise(lines, a.start_date, end),
        stock_receipts: stock.receipts,
        context_transition: await transition(),
      };
    }

    if (!a.item_name) return { ok: false, error: "item_name required" };

    if (a.action === "remove_item") {
      const qty = a.qty ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > 20)
        return { ok: false, error: "quantity must be a whole number between 1 and 20" };
      if (isGenericItemQuery(a.item_name))
        return { ok: false, error: `"${a.item_name}" names a category. Ask which exact booked model to remove; no items or prices changed.` };
      const inventory = nativeItems;
      const candidates = lines.map(line => ({ line, native: inventory.find(i => String(i._id) === line.item_id) }));
      // Physical identity and reviewed aliases outrank advertising-title prose.
      // A7 II is not A7 III; an FX3 title mentioning A7S III is still an FX3.
      const match = bestMatch(a.item_name, candidates,
        c => c.native?.name_canonical ?? c.line.name, c => c.native?.aliases ?? []);
      if (!match.match || !match.confident)
        return {
          ok: false,
          error: `"${a.item_name}" does not identify one specific booked line. Ask which exact model they mean. No items or prices changed. Do not claim it is included in a kit without checking the native kit contents.`,
        };
      const selected = match.match.line;
      if (!Number.isInteger(selected.qty) || selected.qty < qty)
        return { ok: false, error: `Only ${selected.qty}x ${selected.name} are on this booking. Do not remove more than the booked quantity; no items or prices changed.` };
      selected.qty -= qty;
      const kept = lines.filter(l => l !== selected || selected.qty > 0);
      summaryText = `removed ${qty}x ${match.match.native?.name_canonical ?? selected.name}`;
      await ctx.db.patch(row._id, {
        items: kept.map((l) => ({ ...l, item_id: l.item_id as never })),
        changes: [...row.changes, { at: Date.now(), summary: summaryText, ...(requestKey ? {request_key:requestKey} : {}) }],
        updated_at: Date.now(),
      });
      return {
        ok: true,
        action_performed: true,
        applied: summaryText,
        order: summarise(kept, row.start_date, row.end_date),
        context_transition: await transition(),
      };
    }

    // add_item
    const owned = nativeItems.filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    // A category is not a product. "a lens" resolved to a DZOFilm Vespid
    // 3-Lens Set purely because its one token was covered — a £20/day set
    // added to a booking nobody asked for. Ask which, don't pick.
    if (isGenericItemQuery(a.item_name)) {
      return {
        ok: false,
        error: `"${a.item_name}" names a category, not a specific item — ask the renter WHICH model they want before adding anything`,
      };
    }
    const m = bestMatch(a.item_name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
    if (!m.match || !m.confident) {
      // Refusing beats guessing: adding the wrong lens to a booking is exactly
      // the silent error this whole system is built to avoid.
      return {
        ok: false,
        error: `could not identify "${a.item_name}" as one specific item we own — ask the renter which exact model they mean`,
      };
    }
    const qty = a.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { ok: false, error: "quantity must be a whole number between 1 and 20" };
    // The complete basket check below counts existing kit components. This
    // preliminary check concerns only the requested extra physical units.
    const requested = qty;
    if (!row.start_date || !row.end_date) return { ok: false, error: "Ask for pickup and return dates before adding equipment" };
    const stock = await checkRentalStock(ctx, { item_name: m.match.name_canonical, quantity: requested, start_date: row.start_date, end_date: row.end_date, thread_id: a.thread_id });
    if (stock.available !== true) return { ok: false, error: `Cannot add ${requested}x ${m.match.name_canonical} for these dates (${stock.reason}); ${stock.free_units ?? "unknown"} units free. Do not claim the change happened.` };

    const price = await resolveDailyPrice(
      ctx,
      row.account_slug,
      String(m.match._id),
      m.match.name_canonical,
    );
    // Multi-day tiers for the listing this item was priced from, so an added
    // lens gets the same length discount the renter would get on Hygglo.
    const pricedPid = await listingPidForItem(ctx, row.account_slug, String(m.match._id));
    const tiers = pricedPid != null
      ? await tiersForProduct(ctx, row.account_slug, pricedPid)
      : undefined;

    // One physical ID can be sold as a body or as several different kits.
    // Merge only the same commercial offering with identical captured terms.
    const already = lines.find(l => l.item_id === String(m.match!._id) &&
      (pricedPid != null ? l.product_id === pricedPid : l.product_id == null && l.pricing_basis === "catalog") &&
      l.daily_price_gbp === price && JSON.stringify(l.price_tiers ?? []) === JSON.stringify(tiers ?? []));
    const additionLine: OrderLine = {
      item_id: String(m.match._id), name: already?.name ?? m.match.name_canonical, qty,
      ...(pricedPid != null ? {product_id:pricedPid} : {}),
      daily_price_gbp:price, pricing_basis:pricedPid != null ? "listing" : "catalog",
      price_tiers:tiers, origin:"added",
    };
    if (already) {
      already.qty += qty;
      summaryText = `${already.name} qty -> ${already.qty}`;
    } else {
      lines.push(additionLine);
      summaryText = `added ${qty}x ${m.match.name_canonical}${price != null ? ` at £${price}/day` : ""}`;
    }

    const basketStock = await checkOrderRentalStock(ctx, row.account_slug, lines, row.start_date, row.end_date, a.thread_id);
    if (basketStock.available !== true) {
      const constraints = basketStock.receipts.filter(r => r.available !== true)
        .map(r => `${r.item_name}: the complete basket needs ${r.requested_units}, ${r.free_units ?? "unknown"} free`).join("; ");
      return { ok: false, error_code: "basket_stock_unavailable_or_unknown",
        error: `Cannot add this item to the complete basket for ${row.start_date} – ${row.end_date}: ${constraints || basketStock.reason}. Kit contents already consume stock. No items or prices were changed. Explain the basket capacity; do not call the extra item itself booked or unavailable based only on a larger combined-quantity check.`,
        stock_receipts: basketStock.receipts };
    }

    if (a.preview_only) {
      const quote = summarise(lines, row.start_date, row.end_date);
      const baseQuote = summarise(row.items, row.start_date, row.end_date);
      const additionQuote = summarise([additionLine], row.start_date, row.end_date);
      if (quote.total_gbp == null || baseQuote.total_gbp == null || additionQuote.total_gbp == null) return {ok:false,error:"The complete proposed basket has unpriced items. Ask the owner for a quote; no items or prices changed."};
      return {ok:true, action_performed:false, preview_only:true, source:"native_lab_proposal" as const,
        thread_id:a.thread_id, account_slug:row.account_slug,
        base_items:row.items.map(l=>({name:l.name,quantity:l.qty})),
        added_items:[{name:additionLine.name,quantity:qty}], quote,
        base_quote:baseQuote, addition_quote:additionQuote,
        additional_cost_gbp:quote.total_gbp-baseQuote.total_gbp,
        stock_receipt:{...stock,start_date:row.start_date,end_date:row.end_date},
        stock_receipts:basketStock.receipts};
    }

    await ctx.db.patch(row._id, {
      items: lines.map((l) => ({ ...l, item_id: l.item_id as never })),
      changes: [...row.changes, { at: Date.now(), summary: summaryText, ...(requestKey ? {request_key:requestKey} : {}) }],
      updated_at: Date.now(),
    });
    return {
      ok: true,
      action_performed: true,
      applied: summaryText,
      order: summarise(lines, row.start_date, row.end_date),
      stock_receipt: { ...stock, start_date: row.start_date, end_date: row.end_date },
      stock_receipts: basketStock.receipts,
      context_transition: await transition(),
    };
  },
});

/** A final platform event, never a renter's claim or a pending document check. */
export const simulateVerificationFailure = mutation({
  args: { thread_id: v.string(), referral_code: v.string() },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    if (!/^[a-f0-9-]{36}$/i.test(a.referral_code)) throw new Error("Use a generated referral code");
    const booking = await getBotBooking(ctx, a.thread_id);
    const order = await getLabOrder(ctx, a.thread_id);
    if (!booking || !order) throw new Error("A simulated booking and basket are required");
    const old = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", a.thread_id)).unique();
    if (old) {
      if (rentalStage(booking, londonToday()).stage !== "VERIFICATION_FAILED") throw new Error("Failure event no longer matches the booking");
      return { ok: true, already_applied: true, referral_code: old.code, message: verificationFailureReply(old.code) };
    }
    if (rentalStage(booking, londonToday()).stage !== "AWAITING_VERIFICATION")
      throw new Error("Only a booking awaiting verification can receive this final failure event");
    if (await ctx.db.query("renter_bot_lab_referrals").withIndex("by_code", q => q.eq("code", a.referral_code)).unique())
      throw new Error("Referral code already exists");
    const now = Date.now();
    await ctx.db.patch(booking._id, { status: "cancelled", order_step: "VERIFICATION_FAILED" });
    await ctx.db.patch(order._id, { changes: [...order.changes, { at: now, summary: "Final verification failure: simulated booking automatically cancelled" }], updated_at: now });
    await ctx.db.insert("renter_bot_lab_referrals", { code: a.referral_code, source_thread_id: a.thread_id, account_slug: order.account_slug, created_at: now, expires_at: now + 7 * 86400000 });
    const message = verificationFailureReply(a.referral_code);
    await ctx.db.insert("hygglo_messages", { account_slug: order.account_slug, thread_id: a.thread_id, message_id: `${a.thread_id}-verification-failed`, sender: "owner", sender_name: "Lab owner", body_text: message, hygglo_sent_at: now, fetched_at: now });
    return { ok: true, already_applied: false, referral_code: a.referral_code, message };
  },
});

/** Explicit basket handoff. No inherited verification, payment or approval. */
export const redeemReferral = mutation({
  args: { thread_id: v.string(), code: v.string() },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    const referral = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_code", q => q.eq("code", a.code)).unique();
    if (!referral || referral.expires_at <= Date.now()) return { ok: false, error: "Referral is invalid or expired" };
    if (referral.source_thread_id === a.thread_id) return { ok: false, error: "A friend needs their own new booking" };
    if (referral.redeemed_by) return referral.redeemed_by === a.thread_id
      ? { ok: true, already_applied: true, message: "This referral is already linked to your request. No duplicate items were added and your current basket has not been changed. Your own booking still needs the platform checks." } : { ok: false, error: "Referral has already been used" };
    const target = await getLabOrder(ctx, a.thread_id);
    const source = await getLabOrder(ctx, referral.source_thread_id);
    const booking = await getBotBooking(ctx, referral.source_thread_id);
    if (!source || !target || target.account_slug !== referral.account_slug || rentalStage(booking, londonToday()).stage !== "VERIFICATION_FAILED")
      return { ok: false, error: "Referral does not match this account or a cancelled verification failure" };
    if (await getBotBooking(ctx, a.thread_id) || target.items.length || target.changes.length)
      return { ok: false, error: "Start an empty inquiry for the friend's own booking" };
    if (!source.start_date || !source.end_date || source.start_date < londonToday())
      return { ok: false, error: "Original dates have passed. Choose new dates with the owner" };
    const lines = [];
    for (const old of source.items) {
      if (old.product_id != null) {
        const listing = await ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", target.account_slug).eq("product_id", old.product_id!)).unique();
        if (!listing || typeof listing.daily_price !== "number") return { ok: false, error: "A basket listing is no longer priced. Ask the owner to check it" };
        lines.push({ ...old, name: listing.name ?? old.name, daily_price_gbp: listing.daily_price, price_tiers: await tiersForProduct(ctx, target.account_slug, old.product_id), pricing_basis: "listing" as const });
      } else if (old.item_id) {
        const item = await ctx.db.get(old.item_id);
        if (!item || item.status !== "active" || item.is_marketing_only || (item.qty ?? 0) < old.qty) return { ok: false, error: "An item is no longer owned and available" };
        const daily = await resolveDailyPrice(ctx, target.account_slug, String(item._id), item.name_canonical);
        const pid = await listingPidForItem(ctx, target.account_slug, String(item._id));
        if (daily == null || pid == null) return { ok: false, error: "An item needs a current listing price" };
        lines.push({ ...old, name: item.name_canonical, daily_price_gbp: daily, price_tiers: await tiersForProduct(ctx, target.account_slug, pid), pricing_basis: "listing" as const });
      } else return { ok: false, error: "Unresolved item identity: ask the owner to check the basket" };
    }
    const stock = await checkOrderRentalStock(ctx, target.account_slug, lines, source.start_date, source.end_date, a.thread_id);
    if (stock.available !== true) return { ok: false, error: "Original basket is no longer available for these dates", stock_receipts: stock.receipts };
    const quote = summarise(lines.map(l => ({ ...l, item_id: l.item_id ? String(l.item_id) : undefined })), source.start_date, source.end_date);
    if (quote.total_gbp == null || quote.unpriced.length) return { ok: false, error: "Basket needs current pricing; ask the owner before restoring it" };
    const display = await listingDisplayCatalog(ctx, target.account_slug);
    const message = friendBasketReply({ ...quote, lines: lines.map(l => ({ qty: l.qty, name: l.product_id != null ? display.name(target.account_slug, l.product_id, l.name) : shortItemName(l.name) })) });
    const now = Date.now();
    await ctx.db.patch(target._id, { items: lines, start_date: source.start_date, end_date: source.end_date, changes: [{ at: now, summary: "Friend referral: basket restored with fresh prices and stock; new booking checks still required" }], updated_at: now });
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", a.thread_id)).first();
    if (conv) await ctx.db.patch(conv._id, { inquiry_items: lines.map(l => ({ name: l.name, qty: l.qty, ...(l.product_id != null ? { product_id: l.product_id } : {}) })) });
    await ctx.db.patch(referral._id, { redeemed_by: a.thread_id });
    await ctx.db.insert("hygglo_messages", { account_slug: target.account_slug, thread_id: a.thread_id, message_id: `${a.thread_id}-friend-referral`, sender: "owner", sender_name: "Lab owner", body_text: message, hygglo_sent_at: now, fetched_at: now });
    return { ok: true, already_applied: false, order: quote, message, stock_receipts: stock.receipts };
  },
});
