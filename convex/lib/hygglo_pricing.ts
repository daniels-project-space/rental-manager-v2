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
  // Shorter than the smallest tier: fall back to that tier's rate rather than
  // returning nothing, so a 1-day hire still prices when only a 3-day row set.
  return rate ?? (usable[0].pricePerDay as number);
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

/** Compact "1 day £80, 3+ days £67/day, 7+ days £50/day" for the prompt. */
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
        ? `1 day £${Math.round(t.pricePerDay as number)}`
        : `${t.days}+ days £${Math.round(t.pricePerDay as number)}/day`,
    )
    .join(", ");
}
