import type { Doc } from "../_generated/dataModel";

/** Match Convex string-index byte ordering, including non-ASCII source data. */
export function compareSourceStrings(a: string, b: string): number {
  if (a === b) return 0;
  if (/^[\x00-\x7f]*$/.test(a) && /^[\x00-\x7f]*$/.test(b)) return a < b ? -1 : 1;
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Source snapshots retain the database's creation-time order. Stable sorting
 * consequently retains the database tie breaker for fully tied index keys. */
export function startDateWindow(
  rows: readonly Doc<"reservations">[], cutoff: string,
): Doc<"reservations">[] {
  return rows.filter(row => row.start_date !== undefined && compareSourceStrings(row.start_date, cutoff) >= 0)
    .sort((a, b) => compareSourceStrings(a.start_date!, b.start_date!) || a._creationTime - b._creationTime);
}

export function accountStatusRows(rows: readonly Doc<"reservations">[], account: string) {
  return rows.filter(row => row.account_slug === account)
    .sort((a, b) => compareSourceStrings(a.status, b.status) || a._creationTime - b._creationTime);
}

export type ItemAnalyticsInputs = {
  reservations: readonly Doc<"reservations">[];
  items: readonly Doc<"items">[];
};
export type ItemPricingAnalyticsInputs = ItemAnalyticsInputs & {
  pricing: readonly Doc<"pricing_catalog">[];
};

export type PricingAnalyticsInputs = Pick<ItemPricingAnalyticsInputs, "reservations" | "pricing">;

export type SnapshotResult<T> = { ok:true; value:T } | { ok:false; error:string };
export type BundleDefinitions = {
  bundles: readonly Doc<"bundles">[];
  bundleItems: readonly Doc<"bundle_items">[];
};
export type SlowAnalyticsSnapshot = {
  reservations:Doc<"reservations">[];
  items:Doc<"items">[];
  pricing:Doc<"pricing_catalog">[];
  capturedAt:number;
  bundleDefinitions:SnapshotResult<BundleDefinitions>;
  attributionOverrides:SnapshotResult<readonly Doc<"listing_resolution_override">[]>;
};
export type WidgetAnalyticsInputs = ItemPricingAnalyticsInputs & {
  bundleDefinitions:SnapshotResult<BundleDefinitions>;
};
export function requireSnapshot<T>(result:SnapshotResult<T>):T {
  if(!result.ok)throw Error(result.error);
  return result.value;
}
