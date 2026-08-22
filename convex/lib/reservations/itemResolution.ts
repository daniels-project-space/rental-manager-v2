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

/** Model-identifier tokens of a canonical item name (a7iii, fx3, 24-70, mk2…). */
export function modelTokensOf(name: string): string[] {
  const out = new Set<string>();
  const re = /\b([a-z]+\d+\w*|[a-z]+\s*[ivx]{1,4}\b|\d+\.\d+|\d+[a-z]+)/gi;
  for (const m of name.toLowerCase().matchAll(re)) {
    out.add(m[1].replace(/\s+/g, ""));
  }
  return Array.from(out);
}

/**
 * Structural sanity check for an LLM-resolved item name against the listing
 * title(s) it is claimed to describe. Names with no discriminating token are
 * accepted (nothing to contradict).
 */
export function passesNameSanityCheck(
  canonical: string,
  titles: Array<{ name?: string }>,
): boolean {
  const toks = modelTokensOf(canonical);
  if (toks.length === 0) return true; // no discriminating tokens — accept
  const cleaned = titles
    .map((t) => stripParentheticalComparisons(t.name ?? "").toLowerCase().replace(/\s+/g, ""))
    .filter((s) => s.length > 0);
  return toks.some((t) => cleaned.some((c) => c.includes(t)));
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
