/**
 * Hygglo multi-day pricing.
 *
 * A listing does not have one price — it has a tier table, and the renter pays
 * the tier that covers their rental length. A real example (leo#1172440):
 *
 *     1 day   £80/day    total £80
 *     3 days  £66.67/day total £200
 *     7 days  £50/day    total £350
 *
 * Everything here previously used the 1-day rate and multiplied by the day
 * count, so a 4-day booking was quoted £320 when Hygglo charges £267. Quoting
 * MORE than the renter would actually pay is the worst direction to be wrong
 * in: it loses the booking and it is not even our price.
 */

export interface PriceTier {
  days?: number;
  pricePerDay?: number;
  price?: number;
}

/** Calendar dates are inclusive for Hygglo pricing; UTC avoids DST-dependent counts. */
export function inclusiveRentalDays(start?: string | null, end?: string | null): number | null {
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const a = Date.parse(`${start}T00:00:00Z`), b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a
    || new Date(a).toISOString().slice(0, 10) !== start || new Date(b).toISOString().slice(0, 10) !== end) return null;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * The per-day rate that applies to a rental of `days`.
 *
 * Tiers are band starts: the applicable one is the LARGEST tier whose day
 * threshold is still <= the rental length (4 days uses the 3-day tier). Tiers
 * with no rate — Hygglo returns an empty 30-day row when the owner hasn't set
 * one — are ignored rather than treated as free.
 */
export function tierRateForDays(
  tiers: PriceTier[] | null | undefined,
  days: number,
): number | null {
  if (!tiers || tiers.length === 0) return null;
  const usable = tiers
    .filter(
      (t) =>
        typeof t.days === "number" &&
        typeof t.pricePerDay === "number" &&
        t.pricePerDay > 0,
    )
    .sort((a, b) => (a.days as number) - (b.days as number));
  if (usable.length === 0) return null;
  let rate: number | null = null;
  for (const t of usable) {
    if ((t.days as number) <= days) rate = t.pricePerDay as number;
  }
  // A longer-hire band is not evidence of a shorter-hire rate.
  return rate;
}

/** What the renter pays in total, rounded to whole pounds as Hygglo shows it. */
export function tierTotalForDays(
  tiers: PriceTier[] | null | undefined,
  days: number,
): number | null {
  const rate = tierRateForDays(tiers, days);
  if (rate == null) return null;
  return Math.round(rate * days);
}

/** Display rate precision without turning £36.67/day into £37/day. */
export function formatGbp(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Shared line arithmetic: the Lab's whole-pound total policy, from raw rates. */
export function rentalQuote(tiers: PriceTier[] | null | undefined, fallbackRate: number | null | undefined, days: number, quantity = 1) {
  if (!Number.isInteger(days) || days < 1 || days > 366 || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return null;
  const tierRate = tierRateForDays(tiers, days);
  const rate = tierRate ?? fallbackRate;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const daily = Math.round(rate * 100) / 100;
  return { days, quantity, daily_rate_gbp: daily, daily_rate_is_approximate: Math.abs(rate - daily) > 0.000001,
    listed_total_gbp: Math.round(rate * days * quantity), total_rounding: "whole_pound" as const,
    source: tierRate != null ? "hygglo_tier" as const : "hygglo_listing" as const };
}

/** Compact tier facts; a rounded daily display never replaces the total. */
export function describeTiers(tiers: PriceTier[] | null | undefined): string | null {
  if (!tiers) return null;
  const usable = tiers
    .filter(
      (t) =>
        typeof t.days === "number" &&
        typeof t.pricePerDay === "number" &&
        t.pricePerDay > 0,
    )
    .sort((a, b) => (a.days as number) - (b.days as number));
  if (usable.length === 0) return null;
  return usable
    .map((t) =>
      t.days === 1
        ? `1 day £${formatGbp(t.pricePerDay as number)}`
        : `${t.days}+ days ~£${formatGbp(t.pricePerDay as number)}/day (£${formatGbp(typeof t.price === "number" ? t.price : Math.round((t.pricePerDay as number) * (t.days as number)))} for ${t.days} days)`,
    )
    .join(", ");
}
