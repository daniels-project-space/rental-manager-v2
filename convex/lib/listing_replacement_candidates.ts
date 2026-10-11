import type { QueryCtx } from "../_generated/server";
import { loadListingInventory } from "./listing_inventory";
import { loadStockSources } from "./renter_stock";
import { checkOrderRentalStock } from "./renter_order_stock";
import { sameMount, substitutionScore } from "./item_name_match";
import { listingKitContext } from "./listing_kit_context";
import { inventorySpecMap } from "./inventory_spec_grounding";
import {
  requestedCameraRole,
  verifiedCameraCapabilities,
  assessCameraRequirements,
} from "./camera_requirements";
import {
  verifiedLensCapabilities,
  assessLensRequirements,
} from "./lens_requirements";

const kind = (value: string | null | undefined) =>
  (value ?? "")
    .toLowerCase()
    .replace(/_?(body|bodies)$/, "")
    .replace(/_+$/, "");
type Args = {
  account_slug: string;
  target_product_id: number;
  candidate_cursor?: string;
  quantity?: number;
  start_date?: string;
  end_date?: string;
  thread_id?: string;
  basket_lines?: Array<{ name: string; qty: number; product_id?: number }>;
  omit_product_ids?: number[];
};
/** Exact account-listing identities; no catalogue, order or messaging writes. */
export async function listingReplacementCandidates(ctx: QueryCtx, a: Args) {
  const sources = await loadStockSources(ctx);
  const original = await loadListingInventory(
    ctx,
    a.account_slug,
    a.target_product_id,
    a.quantity ?? 1,
    sources,
  );
  const empty = (reason: string) => ({
    alternatives: [],
    reason,
    is_done: true,
    continue_cursor: null,
  });
  if (!original.complete)
    return empty("The requested listing needs its inventory mapping reviewed.");
  const items = new Map(sources.items.map((item) => [String(item._id), item]));
  const value = (components: typeof original.components) => {
    let total = 0;
    for (const component of components.filter((c) => c.stock_required)) {
      const cost = items.get(component.item_id)?.replacement_cost_gbp;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
        return null;
      total += cost * component.requested_units;
    }
    return total;
  };
  const originalValue = value(original.components);
  if (originalValue == null)
    return empty("The requested kit needs its replacement value reviewed.");
  const specs = inventorySpecMap(await ctx.db.query("item_specs").collect());
  const page = await ctx.db
    .query("online_listings")
    .withIndex("by_account", (q) => q.eq("account_slug", a.account_slug))
    .paginate({ numItems: 64, cursor: a.candidate_cursor ?? null });
  const listings = page.page;
  const retained = (a.basket_lines ?? []).filter(
    (line) => !(a.omit_product_ids ?? []).includes(line.product_id ?? -1),
  );
  const excluded = new Set([
    a.target_product_id,
    ...(a.basket_lines ?? []).map((line) => line.product_id),
  ]);
  const alternatives: any[] = [];
  for (const listing of listings) {
    if (listing.is_published === false || excluded.has(listing.product_id))
      continue;
    const contents = await loadListingInventory(
      ctx,
      a.account_slug,
      listing.product_id,
      a.quantity ?? 1,
      sources,
    );
    if (!contents.complete || contents.owned !== true) continue;
    const candidateValue = value(contents.components);
    if (candidateValue == null || candidateValue > originalValue) continue;
    // Every mapped kit component must retain its type, mount and unit count.
    // Matching the main camera alone cannot certify a two-camera or body/lens kit.
    let compatible = true;
    const capacities = contents.components.map((component) => ({
      component,
      remaining: component.requested_units,
    }));
    for (const source of original.components) {
      const sourceItem = items.get(source.item_id);
      if (!sourceItem || !kind(source.kind)) {
        compatible = false;
        break;
      }
      let required = source.requested_units;
      for (const candidate of capacities) {
        const item = items.get(candidate.component.item_id);
        if (
          !item ||
          kind(item.kind) !== kind(source.kind) ||
          (sourceItem.lens_mount &&
            !sameMount(item.lens_mount ?? "", sourceItem.lens_mount))
        )
          continue;
        if (kind(source.kind) === "camera") {
          const profile = verifiedCameraCapabilities(
            specs.get(source.item_id),
            sourceItem.name_canonical,
          );
          const role =
            profile?.role ??
            requestedCameraRole(sourceItem.name_canonical, sourceItem.kind);
          if (
            !role ||
            assessCameraRequirements(
              verifiedCameraCapabilities(
                specs.get(String(item._id)),
                item.name_canonical,
              ),
              { role },
              sourceItem.lens_mount ?? undefined,
            ).status !== "match"
          )
            continue;
        }
        if (
          kind(source.kind) === "lens" &&
          assessLensRequirements(
            verifiedLensCapabilities(
              specs.get(String(item._id)),
              item.name_canonical,
            ),
            {},
          ).status !== "match"
        )
          continue;
        const used = Math.min(required, candidate.remaining);
        required -= used;
        candidate.remaining -= used;
      }
      if (required > 0) {
        compatible = false;
        break;
      }
    }
    if (!compatible) continue;
    let mediaReview = false;
    for (const component of contents.components.filter(
      (c) => kind(c.kind) === "camera",
    )) {
      const kit = await listingKitContext(
        ctx,
        a.account_slug,
        items.get(component.item_id),
        contents.components,
        sources.items,
      );
      if (kit.contents_review_required) {
        mediaReview = true;
        break;
      }
    }
    if (mediaReview || !a.start_date || !a.end_date) continue;
    const stock = await checkOrderRentalStock(
      ctx,
      a.account_slug,
      [
        ...retained,
        {
          name: listing.name,
          qty: a.quantity ?? 1,
          product_id: listing.product_id,
        },
      ],
      a.start_date,
      a.end_date,
      a.thread_id ?? "",
      sources,
    );
    if (stock.available !== true) continue;
    const sourceMain = original.components.find((c) => c.stock_required),
      candidateMain = contents.components.find((c) => c.stock_required);
    alternatives.push({
      product_id: listing.product_id,
      item_id: candidateMain?.item_id,
      name: listing.name,
      listing_name: listing.name,
      image_url: listing.image ?? null,
      mapping_complete: true,
      storage_contents_verification_required: false,
      availability: { available: true },
      replacement_cost_gbp: candidateValue,
      score: substitutionScore(
        { name: sourceMain?.name ?? "", kind: kind(sourceMain?.kind) },
        { name: candidateMain?.name ?? "", kind: kind(candidateMain?.kind) },
      ),
    });
  }
  alternatives.sort((a, b) => b.score - a.score || a.product_id - b.product_id);
  return {
    alternatives: alternatives.slice(0, 6),
    reason: alternatives.length
      ? null
      : "No complete compatible listing with verified stock and value was found.",
    is_done: page.isDone,
    continue_cursor: page.isDone ? null : page.continueCursor,
  };
}
