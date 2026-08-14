/**
 * Bulk listing-price administration (2026-08-14).
 *
 * Applies a percentage change to the ONE-DAY price tier of every listing on a
 * Hygglo account. This edits LIVE marketplace listings — real money — so the
 * module is deliberately built as two phases with three independent safeties:
 *
 *   1. `dryRunPriceChange`  — a pure QUERY. Zero side effects: it never calls
 *      Hygglo and never writes to Convex. Returns the exact diff that WOULD be
 *      applied so a human (or WallE) can read it before agreeing to anything.
 *   2. `createPriceChangeProposal` — freezes that diff into
 *      `price_change_proposals` and returns a single-use `token`.
 *   3. `executePriceChange` — the ONLY writing entry point. Refuses unless
 *      ALL of: `ALLOW_LISTING_PRICE_WRITES === "true"`, a non-empty
 *      `confirmation_token` that resolves to an unconsumed, unexpired proposal
 *      matching this exact account_slug + percent_change, and a per-listing
 *      live-price drift check.
 *
 * Why an env gate on top of the token (mirrors `src/lib/hygglo-write.ts`):
 * the token proves WHICH change was approved; the env var proves price writes
 * are switched on AT ALL. Neither implies the other, and the env var defaults
 * to unset, so on a deployment where nobody has set it this module is inert no
 * matter what any caller (or a confused LLM) does.
 *
 * NOTE on reaching Hygglo: this module does NOT import
 * `src/lib/hygglo/listings.ts`. That module is Next-oriented (pulls in
 * @/hygglo-core + aws-sdk + the renderer, and its route is `server-only`) and
 * is explicitly kept out of Convex's dependency graph — see the same note at
 * the top of `convex/online_listings_actions.ts`. Instead the action calls the
 * existing Next route `PATCH /api/listings/{account}/item/{lid}`, which reuses
 * the proven GET → merge → PUT write mechanics in `editListing`. Reimplementing
 * that merge here would risk the documented Hygglo gotchas (PATCH silently
 * ignores price; the image reference must be a bare filename on PUT).
 */
import { action, mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Same allowlist as `src/lib/hygglo/listings.ts` and `online_listings_actions.ts`. */
const ALLOWED_ACCOUNTS = new Set(["leo", "dbcinema", "diogo"]);

/** A frozen proposal is only good for 15 minutes. */
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** Refuse absurd swings outright — a fat-fingered 500 must never reach Hygglo. */
const MAX_ABS_PERCENT = 50;

/** Never publish a sub-£1 day rate, whatever the maths says. */
const MIN_PRICE = 1;

/** Cached vs live price may differ by at most this before we refuse to write. */
const DRIFT_TOLERANCE = 0.01;

export type PriceRow = {
  listing_id: number;
  name?: string;
  old_price: number;
  new_price: number;
};

export type SkippedRow = {
  listing_id: number;
  name?: string;
  reason: "missing_one_day_tier" | "duplicate_one_day_tier" | "invalid_one_day_price";
};

export type PriceDiff = {
  account_slug: string;
  percent_change: number;
  count: number;
  rows: PriceRow[];
  skipped: SkippedRow[];
};

/**
 * Round to the nearest £0.50, floored at MIN_PRICE.
 *
 * Chosen over nearest-whole-pound because a 5% move on a £12 listing is £0.60 —
 * whole-pound rounding would quantise that to either £12 (no change at all) or
 * £13 (an 8.3% move), i.e. the rounding error would routinely exceed the
 * requested change on cheap listings. £0.50 keeps prices human-readable on a
 * consumer marketplace while keeping the applied change within ~£0.25 of the
 * intended one. Rounding happens LAST, on the final price, so errors never
 * compound.
 */
function roundPrice(value: number): number {
  const rounded = Math.round(value * 2) / 2;
  return Math.max(MIN_PRICE, rounded);
}

function assertAccount(account_slug: string): void {
  if (!ALLOWED_ACCOUNTS.has(account_slug)) {
    throw new Error(`unknown account '${account_slug}'`);
  }
}

function assertPercent(percent_change: number): void {
  if (!Number.isFinite(percent_change)) {
    throw new Error("percent_change must be a finite number");
  }
  if (percent_change === 0) {
    throw new Error("percent_change must be non-zero");
  }
  if (Math.abs(percent_change) > MAX_ABS_PERCENT) {
    throw new Error(`percent_change must be within ±${MAX_ABS_PERCENT}%`);
  }
}

type ProductLike = {
  productId: number;
  name?: string;
  prices?: Array<{ days?: number; pricePerDay?: number; price?: number }>;
};

/**
 * Pure diff builder shared by the dry run and the executor, so the two can
 * never drift apart.
 *
 * Price source: `hygglo_products.prices[]`, the `days === 1` tier — NOT
 * `online_listings.daily_price`. `daily_price` is lossy by construction: see
 * `convex/online_listings_actions.ts:43-52`, where it falls back to
 * `Math.min(...)` across ALL tiers when a listing has no 1-day tier. A listing
 * priced only for 3+ days would therefore report a multi-day per-day rate as
 * its "daily price", and we would silently write that number into a newly
 * created 1-day tier. `hygglo_products.prices[]` preserves the real tier
 * structure, so a missing 1-day tier is visible and gets SKIPPED instead of
 * guessed. It is also the shape the write path needs.
 */
function buildDiff(
  account_slug: string,
  percent_change: number,
  products: ProductLike[],
): PriceDiff {
  const rows: PriceRow[] = [];
  const skipped: SkippedRow[] = [];
  const multiplier = 1 + percent_change / 100;

  for (const p of products) {
    const name = p.name;
    const oneDay = (p.prices ?? []).filter((t) => t.days === 1);

    if (oneDay.length === 0) {
      skipped.push({ listing_id: p.productId, name, reason: "missing_one_day_tier" });
      continue;
    }
    // Ambiguous: we would not know which tier the marketplace actually charges.
    if (oneDay.length > 1) {
      skipped.push({ listing_id: p.productId, name, reason: "duplicate_one_day_tier" });
      continue;
    }

    const current = oneDay[0].pricePerDay ?? oneDay[0].price;
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) {
      skipped.push({ listing_id: p.productId, name, reason: "invalid_one_day_price" });
      continue;
    }

    const next = roundPrice(current * multiplier);
    rows.push({ listing_id: p.productId, name, old_price: current, new_price: next });
  }

  rows.sort((a, b) => a.listing_id - b.listing_id);
  return { account_slug, percent_change, count: rows.length, rows, skipped };
}

// ── Phase 1: read-only dry run ───────────────────────────────────────────────

/**
 * READ-ONLY. Computes what a percentage change would do to every listing on an
 * account. Makes no Hygglo call and writes nothing — safe to call freely, and
 * safe to expose to an LLM.
 */
export const dryRunPriceChange = query({
  args: {
    account_slug: v.string(),
    percent_change: v.number(),
  },
  handler: async (ctx, { account_slug, percent_change }): Promise<PriceDiff> => {
    assertAccount(account_slug);
    assertPercent(percent_change);

    const products = await ctx.db
      .query("hygglo_products")
      .withIndex("by_account", (q) => q.eq("accountSlug", account_slug))
      .collect();

    return buildDiff(account_slug, percent_change, products);
  },
});

/** Internal twin of the dry run, so the action can re-derive a FRESH diff. */
export const computeDiffInternal = internalQuery({
  args: {
    account_slug: v.string(),
    percent_change: v.number(),
  },
  handler: async (ctx, { account_slug, percent_change }): Promise<PriceDiff> => {
    assertAccount(account_slug);
    assertPercent(percent_change);
    const products = await ctx.db
      .query("hygglo_products")
      .withIndex("by_account", (q) => q.eq("accountSlug", account_slug))
      .collect();
    return buildDiff(account_slug, percent_change, products);
  },
});

// ── Phase 2: freeze a proposal ───────────────────────────────────────────────

/**
 * Freezes a dry-run diff and mints a single-use `confirmation_token`.
 *
 * Writes ONLY to our own `price_change_proposals` table — it touches nothing on
 * Hygglo and nothing else in Convex, so calling it is not a real-money action.
 */
export const createPriceChangeProposal = mutation({
  args: {
    account_slug: v.string(),
    percent_change: v.number(),
    source: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { account_slug, percent_change, source },
  ): Promise<{
    token: string;
    expires_at: number;
    count: number;
    rows: PriceRow[];
    skipped: SkippedRow[];
  }> => {
    assertAccount(account_slug);
    assertPercent(percent_change);

    const products = await ctx.db
      .query("hygglo_products")
      .withIndex("by_account", (q) => q.eq("accountSlug", account_slug))
      .collect();
    const diff = buildDiff(account_slug, percent_change, products);

    if (diff.rows.length === 0) {
      throw new Error(
        `no listings on '${account_slug}' have a usable one-day price tier — nothing to propose`,
      );
    }

    const now = Date.now();
    const token = `pcp_${now.toString(36)}_${crypto.randomUUID()}`;
    const expires_at = now + PROPOSAL_TTL_MS;

    await ctx.db.insert("price_change_proposals", {
      token,
      account_slug,
      percent_change,
      proposed: diff.rows.map((r) => ({
        listing_id: r.listing_id,
        name: r.name,
        old_price: r.old_price,
        new_price: r.new_price,
      })),
      created_at: now,
      expires_at,
      source,
    });

    return { token, expires_at, count: diff.count, rows: diff.rows, skipped: diff.skipped };
  },
});

/**
 * Validates a token AND burns it in one transaction. Consumption happens BEFORE
 * any Hygglo call, so a retry or a duplicated action invocation cannot apply the
 * same percentage twice (which would compound: +10% twice = +21%).
 */
export const consumeProposal = internalMutation({
  args: {
    token: v.string(),
    account_slug: v.string(),
    percent_change: v.number(),
  },
  handler: async (ctx, { token, account_slug, percent_change }): Promise<{ source?: string }> => {
    const row = await ctx.db
      .query("price_change_proposals")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!row) throw new Error("confirmation_token does not match any proposal");
    if (row.consumed_at !== undefined) {
      throw new Error("confirmation_token has already been used");
    }
    if (Date.now() > row.expires_at) {
      throw new Error("confirmation_token has expired — run the dry run again");
    }
    if (row.account_slug !== account_slug) {
      throw new Error("confirmation_token was issued for a different account");
    }
    if (row.percent_change !== percent_change) {
      throw new Error("confirmation_token was issued for a different percent_change");
    }

    await ctx.db.patch(row._id, { consumed_at: Date.now() });
    return { source: row.source };
  },
});

/** Append one audit row. Called for every listing, success or failure. */
export const recordAudit = internalMutation({
  args: {
    account_slug: v.string(),
    listing_id: v.number(),
    old_price: v.number(),
    new_price: v.number(),
    source: v.string(),
    success: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<null> => {
    await ctx.db.insert("price_change_audit", { ...a, changed_at: Date.now() });
    return null;
  },
});

// ── Phase 3: the write ───────────────────────────────────────────────────────

/**
 * THE gate. Mirrors `returnWritesAllowed()` in `src/lib/hygglo-write.ts`:
 * an independent, default-off boolean env var owned by exactly one verb.
 *
 * Bulk price editing rewrites live marketplace prices across a whole account,
 * so it is HARD-BLOCKED unless someone deliberately sets
 * ALLOW_LISTING_PRICE_WRITES="true" on the Convex deployment. No code path
 * sets it, so out of the box `executePriceChange` cannot change a single price.
 */
function listingPriceWritesAllowed(): boolean {
  return process.env.ALLOW_LISTING_PRICE_WRITES === "true";
}

type HyggloPriceTier = { days?: number; pricePerDay?: number; price?: number };

function appBase(): string {
  return process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
}

export type ExecuteSummary = {
  ok: boolean;
  account_slug: string;
  percent_change: number;
  succeeded: PriceRow[];
  failed: Array<PriceRow & { error: string }>;
};

/**
 * Applies the approved percentage to every listing's one-day tier.
 *
 * Partial-failure safe: each listing is written independently inside its own
 * try/catch, an audit row is recorded either way, and one failure never aborts
 * the remaining listings.
 */
export const executePriceChange = action({
  args: {
    account_slug: v.string(),
    percent_change: v.number(),
    confirmation_token: v.string(),
  },
  handler: async (
    ctx,
    { account_slug, percent_change, confirmation_token },
  ): Promise<ExecuteSummary> => {
    // 1. Env gate FIRST — before validation, before any read, before anything.
    if (!listingPriceWritesAllowed()) {
      throw new Error(
        "listing price writes are disabled (ALLOW_LISTING_PRICE_WRITES is not \"true\")",
      );
    }

    assertAccount(account_slug);
    assertPercent(percent_change);

    if (typeof confirmation_token !== "string" || confirmation_token.trim() === "") {
      throw new Error("confirmation_token is required");
    }

    // 2. Burn the token before touching Hygglo — a replay must not double-apply.
    const consumed: { source?: string } = await ctx.runMutation(
      internal.listing_price_admin.consumeProposal,
      { token: confirmation_token.trim(), account_slug, percent_change },
    );
    const source = consumed.source ?? "manual";

    // 3. Re-derive the diff from current data. The caller's numbers are never
    //    trusted; the frozen proposal is kept only as a record of what was shown.
    const diff: PriceDiff = await ctx.runQuery(internal.listing_price_admin.computeDiffInternal, {
      account_slug,
      percent_change,
    });

    const succeeded: PriceRow[] = [];
    const failed: Array<PriceRow & { error: string }> = [];
    const base = appBase();

    for (const row of diff.rows) {
      let error: string | undefined;
      try {
        const url = `${base}/api/listings/${encodeURIComponent(account_slug)}/item/${encodeURIComponent(
          String(row.listing_id),
        )}`;

        // 3a. Read the LIVE listing. Both Convex tables are caches, and pricing
        //     off a stale cache could turn an intended rise into a cut.
        const getRes = await fetch(url, { method: "GET" });
        if (!getRes.ok) {
          throw new Error(`GET listing failed (${getRes.status})`);
        }
        const live = (await getRes.json()) as { prices?: HyggloPriceTier[] };
        const livePrices = live.prices ?? [];
        const liveOneDay = livePrices.filter((t) => t.days === 1);
        if (liveOneDay.length !== 1) {
          throw new Error("live listing no longer has exactly one 1-day price tier");
        }
        const livePrice = liveOneDay[0].pricePerDay ?? liveOneDay[0].price;
        if (typeof livePrice !== "number" || !Number.isFinite(livePrice) || livePrice <= 0) {
          throw new Error("live listing has no usable 1-day price");
        }

        // 3b. Drift check. If live has moved since the cache was filled, refuse
        //     rather than apply a change nobody actually approved.
        if (Math.abs(livePrice - row.old_price) > DRIFT_TOLERANCE) {
          throw new Error(
            `price drift: approved from £${row.old_price}, live is £${livePrice} — re-run the dry run`,
          );
        }

        // 3c. Rewrite ONLY the 1-day tier; every other tier passes through
        //     untouched. days === 1 so `price` and `pricePerDay` are the same.
        const nextPrices: HyggloPriceTier[] = livePrices.map((t) =>
          t.days === 1 ? { ...t, pricePerDay: row.new_price, price: row.new_price } : t,
        );

        const patchRes = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prices: nextPrices }),
        });
        if (!patchRes.ok) {
          throw new Error(`PATCH failed (${patchRes.status})`);
        }
        const result = (await patchRes.json()) as { ok?: boolean; error?: string };
        if (result.ok !== true) {
          throw new Error(result.error ?? "Hygglo rejected the price edit");
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      // 4. Audit EVERY attempt, then keep going. One bad listing must not
      //    strand the rest of the batch.
      await ctx.runMutation(internal.listing_price_admin.recordAudit, {
        account_slug,
        listing_id: row.listing_id,
        old_price: row.old_price,
        new_price: row.new_price,
        source,
        success: error === undefined,
        error,
      });

      if (error === undefined) succeeded.push(row);
      else failed.push({ ...row, error });
    }

    return {
      ok: failed.length === 0,
      account_slug,
      percent_change,
      succeeded,
      failed,
    };
  },
});
