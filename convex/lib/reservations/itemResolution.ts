/**
 * Shared per-LISTING-LINE resolution primitives.
 *
 * Extracted 2026-08-22 so the "Rented gear not tracked" banner
 * (`calendar:getUnmappedRentedListings`) and the dashboard's untracked/conflict
 * resolver (`dashboard.ts:expandedIdsOf`) judge a line by the SAME signals.
 * They had drifted: the banner trusted 3 signals, the dashboard trusted 5, so
 * lines the dashboard already treated as correctly resolved were still shouted
 * about as "not tracked". Anything added here must stay PURE (no ctx / no db)
 * so both a query and a helper can call it.
 */

// ── Insurance lines ─────────────────────────────────────────────────────────
/**
 * Hygglo attaches its insurance add-on as an extra `hygglo_items[]` line. It is
 * a fee, not gear: it has no product to map and no inventory to hold. EVERY
 * other consumer of hygglo_items[] filters it out (dashboard.ts:1288,
 * hyggloTiles.ts:57, hygglo.ts:496/667, listing_images.ts:52/155,
 * listing_short_names.ts, listing_info_pool.ts) — this is that same predicate,
 * named once so a new consumer cannot forget it.
 */
export function isInsuranceLine(h: { type?: string } | null | undefined): boolean {
  return !!h && h.type === "INSURANCE";
}

/** A hygglo_items[] line that represents real, mappable gear. */
export function isTrackableLine(
  h: { name?: string; type?: string } | null | undefined,
): boolean {
  return !!h && !!h.name && !isInsuranceLine(h);
}

// ── LLM name-sanity check ───────────────────────────────────────────────────
/**
 * Strip parentheticals containing comparison keywords ("same sensor as ...",
 * "like ...") so marketing copy can't lend its model numbers to the matcher.
 * e.g. "Sony FX3 (same sensor as a7s iii)" must not validate an A7 III pick.
 */
export function stripParentheticalComparisons(s: string): string {
  return s.replace(
    /\([^)]*\b(same|like|equivalent|comparable|as good as|similar|alternative)\b[^)]*\)/gi,
    " ",
  );
}

/** Normalize typographic model variants without erasing model boundaries. */
function normalizedModelName(name: string): string {
  return stripParentheticalComparisons(name).toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\b(fx|rs|a|r|mk|bmpcc)\s+(\d+)/g, "$1$2")
    .replace(/\b([a-z]+\d+[a-z]*)\s+([ivx]{1,4})\b/g, "$1$2")
    .replace(/\bf\s*\/\s*(\d)/g, "f$1")
    .replace(/(\d)\s*mm\b/g, "$1mm");
}

/** Model numbers, focal lengths, apertures and explicit generations. */
export function modelTokensOf(name: string): string[] {
  const re = /\b(?:\d+-\d+mm|f\d+(?:\.\d+)?|[a-z]+\d+[a-z]*|\d+[a-z]+|[ivx]{1,4}|\d+)\b/g;
  return Array.from(new Set(normalizedModelName(name).match(re) ?? []));
}

/** Reject an LLM guess unless one listing supports its full model identity.
 * Shared apertures, substrings (FX3/FX30) and comparison copy are insufficient.
 * Manual listing overrides and product mappings remain authoritative.
 */
export function passesNameSanityCheck(
  canonical: string,
  titles: Array<{ name?: string }>,
): boolean {
  const tokens = modelTokensOf(canonical);
  const required = tokens.length > 0 ? tokens : normalizedModelName(canonical)
    .split(/[^a-z0-9]+/).filter((word) => word && !["kit", "bundle", "camera", "lens"].includes(word));
  if (required.length === 0) return false;
  return titles.some(({ name }) => {
    const title = normalizedModelName(name ?? "");
    const brands = ["sony", "canon", "nikon", "dji", "nanlite", "aputure", "godox", "gopro", "anker", "pioneer", "jbl"];
    const canonicalBrand = brands.find((brand) => new RegExp("\\b" + brand + "\\b").test(canonical.toLowerCase()));
    const listedBrands = brands.filter((brand) => new RegExp("\\b" + brand + "\\b").test(title));
    if (canonicalBrand && listedBrands.length > 0 && !listedBrands.includes(canonicalBrand)) return false;
    return required.every((token) => {
      // Match standalone model identities, never a prefix of another model.
      return new RegExp("(?<![a-z0-9])" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9])").test(title);
    });
  });
}

// ── Per-line "does this resolve to anything?" ───────────────────────────────

export type LineResolutionMaps = {
  /** `slug#pid` present ⇒ audit-authoritative. Empty components = marketing
   *  (resolves to nothing on purpose — still RESOLVED, not unknown). */
  overrideByProduct: Set<string>;
  /** `slug#pid` → listing_info_pool components (already flag-gated). */
  infoPoolByProduct: Set<string>;
  /** `slug#pid` from hygglo_product_index. */
  productIndex: Set<string>;
  /** `slug#pid` from hygglo_products rows still carrying a masterItemId. */
  catalogueLinked: Set<string>;
};

export type ResolutionLine = { name?: string; type?: string; product_id?: number };
export type ResolutionNamed = { item_name_canonical?: string };

/**
 * True when a single booking line resolves to SOMETHING the rest of the app
 * already trusts. Mirrors `dashboard.ts:expandedIdsOf`'s per-position priority
 * chain (override → info pool → product index → positional LLM pick with a
 * name-sanity check), plus a title-matched `expanded_items[]` fallback for
 * lines Hygglo gave no product_id at all.
 *
 * Deliberately permissive: this decides whether to SHOUT at the owner, and a
 * false alarm is what got the original alert ignored.
 */
export function lineResolvesToSomething(args: {
  accountSlug: string;
  line: ResolutionLine;
  /** Position of this line within the reservation's hygglo_items[]. */
  index: number;
  maps: LineResolutionMaps;
  resolvedItems: ResolutionNamed[];
  expandedItems: ResolutionNamed[];
}): boolean {
  const { accountSlug, line, index, maps, resolvedItems, expandedItems } = args;
  const pid = typeof line.product_id === "number" ? line.product_id : null;

  if (pid !== null) {
    const key = `${accountSlug}#${pid}`;
    if (maps.overrideByProduct.has(key)) return true;
    if (maps.infoPoolByProduct.has(key)) return true;
    if (maps.productIndex.has(key)) return true;
    if (maps.catalogueLinked.has(key)) return true;
  }

  // Positional LLM pick — works with or without a product_id, which is what
  // rescues the `product_id === null` lines the banner used to flag outright.
  const ri = resolvedItems[index];
  if (ri?.item_name_canonical && passesNameSanityCheck(ri.item_name_canonical, [line])) {
    return true;
  }

  // Bundle-decomposed items aren't positional, so match by title instead. Only
  // a name-sanity hit counts, so an unrelated kit member can't absolve a line.
  for (const x of expandedItems) {
    if (!x.item_name_canonical) continue;
    if (passesNameSanityCheck(x.item_name_canonical, [line])) return true;
  }

  return false;
}
