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
