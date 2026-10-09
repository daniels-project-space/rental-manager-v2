import type { Doc } from "../_generated/dataModel";
import { isStandardAccessory } from "./reservations/itemUnits";
import { coverReviewedSuppliedParts } from "./supplied_parts_coverage";
import { resolveBundleMapping, declaredRentalBlockers } from "./bundle_mapping";
import { withDefaultAdapters } from "./default_adapter_units";

type Component = { item_id: string; qty: number };
export function resolveListingComponents(items: Doc<"items">[], override: Component[] | undefined, primaryId?: string, quantity = 1, description?: string) {
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 20;
  const rawDeclared = description ? resolveBundleMapping(description, items) : null;
  // Exact structured contents may complete a partial mapping, using only
  // explicit active owned master records. An empty owner override still wins.
  // Without an override, the declared kit must also include its primary model:
  // a fuzzy primary alone or a lens-only description cannot certify a body kit.
  const verifiedContents = !!rawDeclared?.explicit && rawDeclared.structured &&
    (override===undefined || override.every(c=>Number.isSafeInteger(c.qty)&&c.qty>0)) &&
    rawDeclared.components.length > 0 && rawDeclared.unmatched.length === 0 &&
    rawDeclared.components.every(c => {
      const item=items.find(i=>String(i._id)===c.item_id);
      return item?.status==="active" && item.is_marketing_only===false &&
        Number.isSafeInteger(item.qty) && item.qty>0 && Number.isSafeInteger(c.qty) && c.qty>0;
    });
  const derive = override === undefined && verifiedContents && !!primaryId &&
    rawDeclared!.components.some(c=>c.item_id===primaryId);
  const quantities = new Map<string, number>();
  for (const c of override ?? (derive ? rawDeclared!.components.map(c=>({item_id:c.item_id,qty:c.qty})) : primaryId ? [{ item_id: primaryId, qty: 1 }] : []))
    quantities.set(c.item_id, (quantities.get(c.item_id) ?? 0) + c.qty);
  const declared_components_added: Component[]=[];
  if (verifiedContents && (derive || !!override?.length)) for (const c of rawDeclared!.components) {
    if ((quantities.get(c.item_id)??0)>=c.qty)continue;
    quantities.set(c.item_id,c.qty);declared_components_added.push({item_id:c.item_id,qty:c.qty});
  }
  const supplied = withDefaultAdapters([...quantities].map(([item_id,qty]) => ({item_id,qty})), items);
  for (const c of supplied.components) quantities.set(c.item_id,c.qty);
  const components = [...quantities].map(([item_id, qty]) => {
    const item = items.find((i) => String(i._id) === item_id);
    const valid = Number.isInteger(qty) && qty > 0;
    return { item_id, name: item?.name_canonical ?? null, kind: item?.kind ?? null,
      units_per_listing: qty, requested_units: qty * quantity,
      stock_required: !item || item.track_independent_stock === true || !isStandardAccessory(item.kind, item.name_canonical),
      owned: !item || !valid ? null : item.status === "active" && !item.is_marketing_only && item.qty > 0 };
  });
  const suppliedParts = rawDeclared && override !== undefined ? coverReviewedSuppliedParts(rawDeclared, items, quantities) : null;
  const declared = suppliedParts?.declared ?? rawDeclared;
  const ownership_blockers = declaredRentalBlockers(declared, items);
  const declaredCameras = declared?.explicit ? declared.components.filter(c => ["camera", "camera_body"].includes(c.kind)) : [];
  // The advertised body remains the item identity even when a bad override
  // omitted it and retained only a lens or card. This does not certify stock.
  const primary_camera = declaredCameras.length === 1 ? declaredCameras[0] : null;
  const coverage = declared?.explicit ? {
    missing: declared.components.filter(c => (quantities.get(c.item_id) ?? 0) < c.qty).map(c => ({item_id:c.item_id,name:c.name,qty:c.qty})),
    unresolved: declared.unmatched,
    structured: declared.structured || (declared.components.length === 1 && declared.components[0].qty === 1),
  } : null;
  const coverageComplete = !coverage || (coverage.structured && !coverage.missing.length && !coverage.unresolved.length);
  const complete = !supplied.unresolved.length && coverageComplete && (override !== undefined || derive) && validQuantity && components.every((c) => c.owned !== null);
  const owned = !validQuantity ? null : override?.length === 0 || ownership_blockers.length > 0 || components.some((c) => c.owned === false) ? false
    : !complete || !components.length ? null : true;
  return { components, complete, owned, primary_camera, ownership_blockers, valid_quantity: validQuantity, supplied_part_bindings:suppliedParts?.bindings??[], declared_components_added, source:derive?"declared_contents":override === undefined ? "primary_item_only" : "listing_override", coverage, unresolved_default_adapters:supplied.unresolved };
}

