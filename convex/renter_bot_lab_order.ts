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
    const hit = cat.find(
      (c: { item_name_canonical: string }) =>
        c.item_name_canonical.toLowerCase().trim() === itemName.toLowerCase().trim(),
    ) as { daily_price_min?: number } | undefined;
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
    return {
      ...summarise(
        row.items.map((i) => ({ ...i, display_name: i.product_id != null ? display.name(row.account_slug, i.product_id, i.name) : i.item_id ? shortItemName(display.itemMap.get(String(i.item_id)) ?? i.name) : shortItemName(i.name), item_id: i.item_id ? String(i.item_id) : undefined })),
        row.start_date,
        row.end_date,
      ),
      changes: row.changes,
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
          price_tiers: await tiersForProduct(ctx, a.account_slug, a.base_product_id as number),
          origin: "listing",
        });
      }
    }
    for (const name of lines.length ? [] : a.item_names) {
      const m = bestMatch(name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      const hit = m.match && m.confident ? m.match : null;
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
        price_tiers: hit ? await (async () => { const pid = await listingPidForItem(ctx, a.account_slug, String(hit._id)); return pid != null ? await tiersForProduct(ctx, a.account_slug, pid) : undefined; })() : undefined,
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
    item_name: v.optional(v.string()),
    qty: v.optional(v.number()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    const row = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .unique();
    if (!row) return { ok: false, error: "no simulated order for this session" };

    const lines: OrderLine[] = row.items.map((i) => ({
      ...i,
      item_id: i.item_id ? String(i.item_id) : undefined,
    }));
    let summaryText = "";

    if (a.action === "set_dates") {
      if (!a.start_date) return { ok: false, error: "start_date required" };
      const end = a.end_date ?? a.start_date;
      if (!validIsoDate(a.start_date) || !validIsoDate(end) || end < a.start_date || inclusiveDays(a.start_date, end) > 366)
        return { ok: false, error: "Use valid pickup and return dates in order, up to 366 rental days" };
      await ctx.db.patch(row._id, {
        start_date: a.start_date,
        end_date: end,
        changes: [
          ...row.changes,
          { at: Date.now(), summary: `dates -> ${a.start_date} to ${end}` },
        ],
        updated_at: Date.now(),
      });
      const booking = await ctx.db.query("renter_bot_lab_bookings")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", a.thread_id)).first();
      if (booking) await ctx.db.patch(booking._id, {
        start_date: a.start_date,
        end_date: end,
        pickup_date: undefined,
        return_date: undefined,
      });
      return {
        ok: true,
        applied: `dates set to ${a.start_date} – ${end}`,
        order: summarise(lines, a.start_date, end),
      };
    }

    if (!a.item_name) return { ok: false, error: "item_name required" };

    if (a.action === "remove_item") {
      const before = lines.length;
      const target = a.item_name.toLowerCase().trim();
      const kept = lines.filter(
        (l) => !l.name.toLowerCase().includes(target) && !target.includes(l.name.toLowerCase()),
      );
      if (kept.length === before)
        // Actionable, because the bot has to SAY something useful here. The
        // usual cause is a renter asking to drop something that is part of the
        // kit rather than a separate line ("actually drop the battery"), where
        // there is nothing to remove and nothing to deduct. Without this the
        // bot claimed a removal that never happened and the guard withheld the
        // entire reply, so the renter got silence.
        return {
          ok: false,
          error: `"${a.item_name}" is not a separate line on this booking — it is most likely part of the kit already. Tell the renter it's included, so there is nothing to remove and nothing to deduct from the price. Do NOT say you removed it.`,
        };
      summaryText = `removed ${a.item_name}`;
      await ctx.db.patch(row._id, {
        items: kept.map((l) => ({ ...l, item_id: l.item_id as never })),
        changes: [...row.changes, { at: Date.now(), summary: summaryText }],
        updated_at: Date.now(),
      });
      return {
        ok: true,
        applied: summaryText,
        order: summarise(kept, row.start_date, row.end_date),
      };
    }

    // add_item
    const owned = (await ctx.db.query("items").collect()).filter(
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
    const already = lines.find((l) => l.item_id === String(m.match!._id));
    const requested = (already?.qty ?? 0) + qty;
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

    if (already) {
      already.qty = requested;
      summaryText = `${already.name} qty -> ${already.qty}`;
    } else {
      lines.push({
        item_id: String(m.match._id),
        name: m.match.name_canonical,
        qty,
        daily_price_gbp: price,
        price_tiers: tiers,
        origin: "added",
      });
      summaryText = `added ${qty}x ${m.match.name_canonical}${price != null ? ` at £${price}/day` : ""}`;
    }

    await ctx.db.patch(row._id, {
      items: lines.map((l) => ({ ...l, item_id: l.item_id as never })),
      changes: [...row.changes, { at: Date.now(), summary: summaryText }],
      updated_at: Date.now(),
    });
    return {
      ok: true,
      applied: summaryText,
      order: summarise(lines, row.start_date, row.end_date),
      stock_receipt: { ...stock, start_date: row.start_date, end_date: row.end_date },
    };
  },
});
