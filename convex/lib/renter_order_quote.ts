import { describeTiers, inclusiveRentalDays, rentalQuote, type PriceTier } from "./hygglo_pricing";
export type PricedOrderLine = { name: string; qty: number; daily_price_gbp?: number; price_tiers?: PriceTier[] };
// Preserve the Lab's daily preview when no duration is supplied. Dated owner
// estimates validate with inclusiveRentalDays before displaying a rental total.
export const inclusiveDays = (start?: string | null, end?: string | null) => inclusiveRentalDays(start, end) ?? 1;
export function summarise<T extends PricedOrderLine>(lines: T[], start?: string, end?: string) {
  const days = inclusiveDays(start, end);
  const priced = lines.map(l => {
    const quote = rentalQuote(l.price_tiers, l.daily_price_gbp, days, l.qty);
    return { ...l, effective_rate_gbp: quote?.daily_rate_gbp ?? null, tiers: describeTiers(l.price_tiers), line_total_gbp: quote?.listed_total_gbp ?? null };
  });
  const known = priced.filter(l => l.line_total_gbp != null);
  return { start_date: start ?? null, end_date: end ?? null, days, lines: priced,
    total_gbp: known.length === priced.length ? known.reduce((n, l) => n + (l.line_total_gbp as number), 0) : null,
    unpriced: priced.filter(l => l.line_total_gbp == null).map(l => l.name) };
}
