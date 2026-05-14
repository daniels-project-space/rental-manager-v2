/**
 * Catalog: pricing, availability, compatibility.
 *
 * Multi-day pricing tiers live in `constants.ts`; if you need to tweak the
 * 3-day or 7-day multipliers, change the constant, not this file.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";
import {
  PRICING_MULTIDAY_MULTIPLIER,
  PRICING_MULTIDAY_THRESHOLD,
  PRICING_WEEKLY_DAYS,
  PRICING_WEEKLY_MULTIPLIER,
} from "./constants";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function lookupPricing(input: {
  itemName: string;
  days?: number;
}): Promise<Result<unknown> | { ok: false; error: string }> {
  try {
    const convex = getConvex();
    const [items, syncState] = await Promise.all([
      convex.query(anyApi.pricing_catalog.lookup, { item_name: input.itemName }),
      getSyncState(),
    ]);
    if (!items || items.length === 0) {
      return { ok: false as const, error: "item_not_found" };
    }
    const row = items[0];
    // daily_price_max = published listing rate;
    // daily_price_min = owner floor (recommendations only)
    const rate: number = row.daily_price_max;
    const days = input.days ?? 1;
    let total: number;
    if (days >= PRICING_WEEKLY_DAYS) total = rate * PRICING_WEEKLY_MULTIPLIER;
    else if (days >= PRICING_MULTIDAY_THRESHOLD)
      total = rate * PRICING_MULTIDAY_MULTIPLIER;
    else total = rate * days;
    return wrap({
      data: {
        ok: true as const,
        item: row.item_name_canonical,
        daily_rate: rate,
        days,
        total: Math.round(total * 100) / 100,
        note:
          days >= PRICING_MULTIDAY_THRESHOLD
            ? "Hygglo multi-day discount applied"
            : undefined,
      },
      source: "convex.pricing_catalog",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function checkAvailability(input: {
  itemName: string;
  startDate: string;
  endDate: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.checkAvailability, {
        item_name: input.itemName,
        start_date: input.startDate,
        end_date: input.endDate,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.checkAvailability", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function checkCompatibility(input: {
  items: string[];
}): Promise<Result<unknown> | { ok: false; error: string }> {
  try {
    const convex = getConvex();
    const { items } = input;
    if (items.length < 2) {
      return { ok: false as const, error: "Provide at least 2 items" };
    }
    const syncState = await getSyncState();
    const results: Array<{
      pair: string[];
      compatible: boolean;
      reason?: string;
      [k: string]: unknown;
    }> = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const result = await convex.query(anyApi.items.checkCompat, {
          itemA: items[i],
          itemB: items[j],
        });
        results.push({ pair: [items[i], items[j]], ...result });
      }
    }
    const conflicts = results.filter((r) => !r.compatible);
    const compatible = results.filter((r) => r.compatible);
    return wrap({
      data: {
        ok: true as const,
        compatible_pairs: compatible.length,
        conflict_pairs: conflicts.length,
        results,
        summary:
          conflicts.length > 0
            ? "CONFLICTS: " +
              conflicts
                .map((r) => r.pair.join(" + ") + " -- " + r.reason)
                .join("; ")
            : "All pairs compatible",
      },
      source: "convex.items.checkCompat",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Item schedule (time-of-day availability) ───────────────────────────────
export async function getItemSchedule(input: {
  itemName: string;
  fromDate?: string;
  toDate?: string;
  account?: "leo" | "dbcinema" | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const today = new Date().toISOString().slice(0, 10);
    const fromDate = input.fromDate ?? today;
    // Default window: 14 days from fromDate.
    const toDate =
      input.toDate ??
      (() => {
        const d = new Date(fromDate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + 14);
        return d.toISOString().slice(0, 10);
      })();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemSchedule, {
        item_name: input.itemName,
        from_date: fromDate,
        to_date: toDate,
        account_slug: input.account ?? undefined,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getItemSchedule", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Per-item monthly earnings (real buckets) ───────────────────────────────
export async function getItemMonthlyEarnings(input: {
  itemName: string;
  months?: number;
  account?: "leo" | "dbcinema" | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemMonthlyEarnings, {
        item_name: input.itemName,
        months: input.months,
        account_slug: input.account ?? undefined,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getItemMonthlyEarnings", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Acquisition cost write + audit ─────────────────────────────────────────

export async function setItemAcquisition(input: {
  itemName?: string;
  itemId?: string;
  costGbp: number;
  acquiredAtIso?: string;             // YYYY-MM-DD; we'll convert to ms
  replacementCostGbp?: number;
}): Promise<Result<unknown> | { ok: false; error: string }> {
  try {
    const convex = getConvex();
    const acquiredAt = input.acquiredAtIso
      ? new Date(input.acquiredAtIso + "T00:00:00Z").getTime()
      : undefined;
    const data = await convex.mutation(anyApi.items.setItemAcquisition, {
      item_name: input.itemName,
      item_id: input.itemId,
      cost_gbp: input.costGbp,
      acquired_at: acquiredAt,
      replacement_cost_gbp: input.replacementCostGbp,
    });
    return wrap({
      data,
      source: "convex.items.setItemAcquisition (mutation)",
      syncState: await getSyncState(),
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function listItemsMissingAcquisition(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.listItemsMissingAcquisition, {}),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.listItemsMissingAcquisition", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Payback / break-even ───────────────────────────────────────────────────

export async function getItemPayback(input: {
  itemName?: string;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemPayback, {
        item_name: input.itemName,
        limit: input.limit,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getItemPayback", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Kit affinity ───────────────────────────────────────────────────────────

export async function getKitAffinity(input: {
  itemName: string;
  minSupport?: number;
  days?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getKitAffinity, {
        item_name: input.itemName,
        min_support: input.minSupport,
        days: input.days,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getKitAffinity", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Dust collectors ────────────────────────────────────────────────────────

export async function getDustCollectors(input: {
  idleDays?: number;
  minCostGbp?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getDustCollectors, {
        idle_days: input.idleDays,
        min_cost_gbp: input.minCostGbp,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getDustCollectors", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── Damage / claim history ─────────────────────────────────────────────────

export async function getItemDamageHistory(input: {
  itemName?: string;
  days?: number;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemDamageHistory, {
        item_name: input.itemName,
        days: input.days,
        limit: input.limit,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.items.getItemDamageHistory", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
