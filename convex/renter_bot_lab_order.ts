import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { bestMatch, isGenericItemQuery } from "./lib/item_name_match";
import { describeTiers, tierRateForDays, type PriceTier } from "./lib/hygglo_pricing";

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
export function inclusiveDays(start?: string | null, end?: string | null): number {
  if (!start || !end) return 1;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

type OrderLine = {
  item_id?: string;
  name: string;
  qty: number;
  daily_price_gbp?: number;
  price_tiers?: PriceTier[];
  origin: string;
};

/** Line totals + grand total, so the Lab and the bot quote the same numbers. */
export function summarise(lines: OrderLine[], start?: string, end?: string) {
  const days = inclusiveDays(start, end);
  const priced = lines.map((l) => {
    // The rate the renter actually pays for THIS length, not the 1-day rate.
    const tiered = tierRateForDays(l.price_tiers, days);
    const rate = tiered ?? l.daily_price_gbp ?? null;
    return {
      ...l,
      effective_rate_gbp: rate,
      tiers: describeTiers(l.price_tiers),
      line_total_gbp: rate != null ? Math.round(rate * l.qty * days) : null,
    };
  });
  const known = priced.filter((l) => l.line_total_gbp != null);
  return {
    start_date: start ?? null,
    end_date: end ?? null,
    days,
    lines: priced,
    // Null rather than 0 when a price is missing: a confidently wrong total is
    // worse than an admitted unknown, and the bot must not quote one.
    total_gbp: known.length === priced.length
      ? known.reduce((n, l) => n + (l.line_total_gbp as number), 0)
      : null,
    unpriced: priced.filter((l) => l.line_total_gbp == null).map((l) => l.name),
  };
}


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
  const pids: number[] = [
    ...idx
      .filter(
        (r: { item_id: unknown; account_slug: string }) =>
          String(r.item_id) === itemId && r.account_slug === accountSlug,
      )
      .map((r: { product_id: number }) => r.product_id),
    ...ov
      .filter(
        (o: { account_slug: string; components: Array<{ item_id: unknown }> }) =>
          o.account_slug === accountSlug &&
          o.components.length === 1 &&
          String(o.components[0].item_id) === itemId,
      )
      .map((o: { product_id: number }) => o.product_id),
  ];
  let best: { pid: number; price: number } | null = null;
  for (const pid of pids) {
    const l = listings.find((x: { product_id: number }) => x.product_id === pid) as
      | { daily_price?: number }
      | undefined;
    if (typeof l?.daily_price !== "number") continue;
    if (!best || l.daily_price < best.price) best = { pid, price: l.daily_price };
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
  const pids: number[] = [
    ...idx
      .filter(
        (r: { item_id: unknown; account_slug: string; product_id: number }) =>
          String(r.item_id) === itemId && r.account_slug === accountSlug,
      )
      .map((r: { product_id: number }) => r.product_id),
    ...ov
      .filter(
        (o: { account_slug: string; components: Array<{ item_id: unknown }>; product_id: number }) =>
          o.account_slug === accountSlug &&
          o.components.length === 1 &&
          String(o.components[0].item_id) === itemId,
      )
      .map((o: { product_id: number }) => o.product_id),
  ];
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
    return {
      ...summarise(
        row.items.map((i) => ({ ...i, item_id: i.item_id ? String(i.item_id) : undefined })),
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
      (i) => i.status === "active" && (i.qty ?? 0) > 0,
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
      await ctx.db.patch(row._id, {
        start_date: a.start_date,
        end_date: end,
        changes: [
          ...row.changes,
          { at: Date.now(), summary: `dates -> ${a.start_date} to ${end}` },
        ],
        updated_at: Date.now(),
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
        return { ok: false, error: `"${a.item_name}" is not on this booking` };
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
    const qty = Math.max(1, Math.min(a.qty ?? 1, m.match.qty ?? 1));

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

    const already = lines.find((l) => l.item_id === String(m.match!._id));
    if (already) {
      already.qty = Math.min(already.qty + qty, m.match.qty ?? 1);
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
    };
  },
});
