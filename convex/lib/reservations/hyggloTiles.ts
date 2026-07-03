/**
 * Shared "rented-listing tiles" builder.
 *
 * Single source of truth for turning a reservation's ACTUAL Hygglo listings
 * (`hygglo_items[]`) into per-listing display tiles, each carrying its OWN
 * listing image. This is what the Active-Rentals widget renders
 * (`convex/dashboard.ts` mapRental) and — since 2026-07-03 — what the calendar
 * day-strip overlay (`getCalendarStrip`) and the fullscreen Gantt overlay
 * (`getGanttWeek`) render too, so all three surfaces agree.
 *
 * Why hygglo_items and NOT resolved_items/override-units: `resolved_items` is
 * frequently INCOMPLETE for multi-listing sets. Example: Willow Bidwell (diogo)
 * rented 6 distinct Hygglo listings (BMPCC 6K FF, GVM light kit, BMPCC 6K Pro,
 * SmallRig tripod, 2x Canon lenses, 4x Sony batteries) but has only 3
 * resolved_items — so a resolved-items view dropped half the set. hygglo_items
 * is the authoritative list of what was actually rented, and every listing
 * carries its own photo.
 *
 * Image resolution order per listing (mirrors dashboard.ts):
 *   1. listing_images bank  (account_slug, product_id)  — trusted canonical
 *   2. hygglo_items[i].image_url  (poller snapshot; skip the example.com seed)
 *   3. image_hints[] by exact item_name  (same-row fallback)
 *   4. null → caller renders a placeholder tile
 *
 * Tiles are grouped by resolved image URL so genuinely-identical photos merge
 * (rare — distinct listings almost always have distinct photos); listings that
 * resolve to no image are appended as placeholder tiles so they still show.
 */

export type HyggloListingTile = {
  productId: number | null;
  name: string;
  imageUrl: string | null;
  qty: number;
};

type HyggloItemLite = {
  name?: string;
  product_id?: number;
  image_url?: string | null;
  type?: string;
  qty?: number;
};

type ImageHintLite = { item_name?: string; image_url?: string };

export function buildHyggloListingTiles(
  reservation: {
    account_slug?: string | null;
    hygglo_items?: HyggloItemLite[] | null;
    image_hints?: ImageHintLite[] | null;
  },
  bankByProduct: Map<string, string>,
): HyggloListingTile[] {
  const acct = reservation.account_slug ?? "";
  const hItems = (reservation.hygglo_items ?? []).filter(
    (h): h is HyggloItemLite => !!h && !!h.name && h.type !== "INSURANCE",
  );
  if (hItems.length === 0) return [];

  const hintByName = new Map<string, string>();
  for (const hint of reservation.image_hints ?? []) {
    if (hint?.item_name && hint.image_url) hintByName.set(hint.item_name, hint.image_url);
  }

  const tileByImg = new Map<string, HyggloListingTile>();
  const order: string[] = [];
  const noImg: HyggloListingTile[] = [];
  for (const h of hItems) {
    const qty = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
    const bankUrl =
      typeof h.product_id === "number" ? bankByProduct.get(`${acct}#${h.product_id}`) : undefined;
    const hyggloUrl =
      h.image_url && !h.image_url.includes("example.com") ? h.image_url : undefined;
    const hintUrl = h.name ? hintByName.get(h.name) : undefined;
    const url = bankUrl ?? hyggloUrl ?? hintUrl ?? null;
    const productId = typeof h.product_id === "number" ? h.product_id : null;
    if (url) {
      const ex = tileByImg.get(url);
      if (ex) {
        ex.qty += qty;
        if ((h.name ?? "").length < ex.name.length) ex.name = h.name ?? ex.name;
      } else {
        tileByImg.set(url, { productId, name: h.name ?? "item", imageUrl: url, qty });
        order.push(url);
      }
    } else {
      noImg.push({ productId, name: h.name ?? "item", imageUrl: null, qty });
    }
  }
  return [...order.map((u) => tileByImg.get(u) as HyggloListingTile), ...noImg];
}
