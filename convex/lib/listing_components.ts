import { powerListingPrimary, matchesBatteryListingRole } from "./power_listing_identity";
import type { Doc } from "../_generated/dataModel";
import { isStandardAccessory } from "./reservations/itemUnits";
import { coverReviewedSuppliedParts } from "./supplied_parts_coverage";
import { resolveBundleMapping, declaredRentalBlockers, matchesGimbalComponentRole, type BundleMappingContext } from "./bundle_mapping";
import { withDefaultAdapters } from "./default_adapter_units";
import { repairReviewedBundle } from "./reviewed_bundle_repairs";
import { declaredLensIdentity } from "./declared_lens_identity";

type Component = { item_id: string; qty: number };
export function resolveListingComponents(items: Doc<"items">[], override: Component[] | undefined, primaryId?: string, quantity = 1, description?: string, context?: BundleMappingContext, listingName?: string) {
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 20;
  let parsed = description ? resolveBundleMapping(description, items, context) : null;
  if(parsed)parsed=repairReviewedBundle(parsed,items,override);
  // A legacy single-model lens listing can state its pack count in one plain
  // sentence rather than a contents heading. Both title and declared sentence
  // must identify the same unique lens; multi-model kits cannot use this path.
  if(parsed && !parsed.explicit && listingName && description){
    const titleLens=declaredLensIdentity(listingName.replace(/\b\d{1,2}\s*[x×]\s*/gi,""),items).item;
    const sentence=description.match(/(?:^|[.!?\n])\s*(\d{1,2})\s*[x×]\s+([^.!?\n]*?(?:lenses|lens))\s*(?:[.!?\n]|$)/i);
    if(titleLens && sentence){
      const pack=resolveBundleMapping(`Contents: • ${sentence[1]}x ${sentence[2]}`,items);
      if(pack.components.length===1 && !pack.unmatched.length && pack.components[0].item_id===String(titleLens._id))parsed=pack;
    }
  }
  const declaredIds=new Set(parsed?.components.map(c=>c.item_id));
  const rules=items.flatMap(item=>(item.listing_stock_rules??[]).filter(rule=>
    String(item._id)===primaryId || rule.apply_to_declared_component===true && parsed?.explicit && parsed.structured && declaredIds.has(String(item._id)) && item.status==="active" && item.is_marketing_only===false && item.qty>0
  )).filter(rule=>{
    if(!listingName || !rule.source.trim() || rule.title_pattern.length>200)return false;
    try{return new RegExp(rule.title_pattern,"i").test(listingName);}catch{return false;}
  });
  const excluded=new Set(rules.flatMap(rule=>rule.excludes.map(String)));
  // Owner-reviewed kit contents can repair corrupted generated descriptions
  // without editing a provider listing or any existing rental document.
  const reviewedDescriptions=[...new Set(rules.flatMap(rule=>rule.description_override?[rule.description_override]:[]))];
  if(reviewedDescriptions.length===1)parsed=resolveBundleMapping(reviewedDescriptions[0],items,context);
  if(parsed && excluded.size)parsed={...parsed,components:parsed.components.filter(c=>!excluded.has(c.item_id))};
  // Reviewed, offering-specific supplied accessories do not invent a separate
  // stock pool. Only an exact recorded name and sufficient count cover a line.
  const partKey=(name:string)=>name.toLowerCase().replace(/\s+/g," ").trim();
  const suppliedPartsFromRules=rules.flatMap(rule=>rule.supplied_parts??[]);
  const optionalParts=new Set(rules.flatMap(rule=>rule.optional_parts??[]).map(partKey));
  if(parsed&&optionalParts.size)parsed={...parsed,unmatched:parsed.unmatched.filter(line=>{
    const m=line.match(/^\d+x (.+)$/);return !m||!optionalParts.has(partKey(m[1]));
  })};
  if(parsed && suppliedPartsFromRules.length)parsed={...parsed,unmatched:parsed.unmatched.filter(line=>{
    const m=line.match(/^(\d+)x (.+)$/);if(!m)return true;
    const matches=suppliedPartsFromRules.filter(p=>partKey(p.name)===partKey(m[2]) && Number.isSafeInteger(p.qty) && p.qty>0);
    return !matches.some(p=>p.qty>=Number(m[1]));
  })};
  const suppliedDeclaration = override===undefined && parsed?.explicit && parsed.structured && primaryId && parsed.components.some(c=>c.item_id===primaryId)
    ? coverReviewedSuppliedParts(parsed,items,new Map(parsed.components.map(c=>[c.item_id,c.qty]))) : null;
  let rawDeclared = suppliedDeclaration?.declared ?? parsed;
  // A lighting unit may record its own bundled stand/reflector without a
  // separate stock pool. Only exact generic parts explicitly recorded on the
  // named, owned master qualify; named or unrecorded equipment stays unknown.
  const primary=items.find(i=>String(i._id)===primaryId);
  // Legacy lexical master links can point an entire gimbal at a spare battery.
  // An unresolved body must stay unresolved, without holding unrelated spares.
  const fallbackPrimary = primary && matchesGimbalComponentRole(listingName ?? "", primary) && matchesBatteryListingRole(listingName ?? "",primary) ? primaryId : undefined;
  if (rawDeclared?.explicit && rawDeclared.structured && ["lighting","dj_audio"].includes(primary?.kind??"") && primary!.status==="active" && primary!.is_marketing_only===false && primary!.qty>0 && (rawDeclared.components.some(c=>c.item_id===primaryId)||override?.some(c=>c.item_id===primaryId))) {
    const partKey=(s:string)=>s.toLowerCase().replace(/^(?:sturdy|height[- ]adjustable)\s+/i,"").replace(/\s*\(height adjustable\)\s*$/i,"").replace(/[^a-z0-9]+/g," ").trim().replace(/^(?:light )?stands?$/, "light stand").replace(/^speaker stands?$/,"speaker stand");
    const knownParts=(primary!.compatibility?.included_with_rental??[]).flatMap(line=>{
      const m=line.match(/^(\d+)\s*[x×]\s+(.+)$/i);
      return m&&/^(?:(?:(?:light|speaker) )?stands?|sandbag|gel kit|reflector)$/i.test(m[2].trim())?[{key:partKey(m[2]),qty:Number(m[1])}]:[];
    });
    const components=rawDeclared.components.map(c=>({...c}));
    const parentAllocation=override?.find(c=>c.item_id===primaryId);
    if(!components.some(c=>c.item_id===primaryId)&&parentAllocation)components.push({item_id:primaryId!,name:primary!.name_canonical,kind:primary!.kind,qty:parentAllocation.qty});
    const unmatched=rawDeclared.unmatched.filter(line=>{
      const m=line.match(/^(?:Ambiguous quantity: 1x )?(\d+)x (.+)$/i);if(!m)return true;
      const matches=knownParts.filter(p=>p.key===partKey(m[2]));if(matches.length!==1||matches[0].qty<1)return true;
      const parent=components.find(c=>c.item_id===primaryId)!;
      parent.qty=Math.max(parent.qty,Math.ceil(Number(m[1])/matches[0].qty));return false;
    });
    rawDeclared={...rawDeclared,components,unmatched};
  }
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
  const titleKey=(text:string)=>text.toLowerCase().replace(/ø/g,"o").replace(/[^a-z0-9]/g,"");
  const title=listingName?.split("|")[0].trim();
  const exactTitle=title?items.filter(i=>[i.name_canonical,...(i.aliases??[])].some(alias=>titleKey(alias)===titleKey(title))):[];
  const powerPrimary = rawDeclared?.explicit && rawDeclared.structured && rawDeclared.components.length===1 && rawDeclared.components[0].kind==="power" && /v[ -]?mount/i.test(listingName??"") && /\d+\s*(?:wh|wah)\b/i.test(listingName??"") ? rawDeclared.components[0].item_id : undefined;
  const declaredPrimary=exactTitle.length===1?String(exactTitle[0]._id):primaryId??powerPrimary??powerListingPrimary(listingName??"",items);
  const derive = override === undefined && verifiedContents && !!declaredPrimary &&
    rawDeclared!.components.some(c=>c.item_id===declaredPrimary);
  const powerTitlePrimary=powerListingPrimary(listingName??"",items);
  const powerTitleQty=(listingName??"").match(/(?:^|\b)(\d{1,2})\s*[x×](?:\b|\s)|\(\s*(\d{1,2})\s*[x×]\s*\)/i);
  const titlePack = powerTitlePrimary && powerTitleQty ? {item_id:powerTitlePrimary,qty:Number(powerTitleQty[1]??powerTitleQty[2])} : null;
  const quantities = new Map<string, number>();
  for (const c of override ?? (derive ? rawDeclared!.components.map(c=>({item_id:c.item_id,qty:c.qty})) : titlePack ? [titlePack] : fallbackPrimary ? [{ item_id: fallbackPrimary, qty: 1 }] : []))
    quantities.set(c.item_id, (quantities.get(c.item_id) ?? 0) + c.qty);
  const declared_components_added: Component[]=[];
  if (verifiedContents && (derive || !!override?.length)) for (const c of rawDeclared!.components) {
    if ((quantities.get(c.item_id)??0)>=c.qty)continue;
    quantities.set(c.item_id,c.qty);declared_components_added.push({item_id:c.item_id,qty:c.qty});
  }
  for(const id of excluded)quantities.delete(id);
  for(const rule of rules)for(const c of rule.components){
    const id=String(c.item_id);if(Number.isSafeInteger(c.qty)&&c.qty>0)quantities.set(id,Math.max(quantities.get(id)??0,c.qty));
  }
  const supplied = withDefaultAdapters([...quantities].map(([item_id,qty]) => ({item_id,qty})), items);
  for (const c of supplied.components) quantities.set(c.item_id,c.qty);
  const components = [...quantities].map(([item_id, qty], index) => {
    const item = items.find((i) => String(i._id) === item_id);
    const valid = Number.isInteger(qty) && qty > 0;
    return { item_id, name: item?.name_canonical ?? null, kind: item?.kind ?? null,
      ...(item?.rental_facts?.source.trim() && item.rental_facts.name.trim() ? {rental_name:item.rental_facts.name} : {}),
      ...(index===0 && suppliedPartsFromRules.length ? {reviewed_supplied_parts:suppliedPartsFromRules} : {}),
      ...(index===0 && optionalParts.size ? {optional_parts:rules.flatMap(rule=>rule.optional_parts??[])} : {}),
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
  const complete = !supplied.unresolved.length && coverageComplete && (override !== undefined || derive || !!titlePack) && validQuantity && components.every((c) => c.owned !== null);
  const owned = !validQuantity ? null : override?.length === 0 || ownership_blockers.length > 0 || components.some((c) => c.owned === false) ? false
    : !complete || !components.length ? null : true;
  return { components, complete, owned, primary_camera, ownership_blockers, valid_quantity: validQuantity, supplied_part_bindings:[...(suppliedDeclaration?.bindings??[]),...(suppliedParts?.bindings??[])], applied_stock_rules:rules.map(rule=>({source:rule.source,title_pattern:rule.title_pattern})), declared_components_added, source:derive?"declared_contents":override === undefined ? "primary_item_only" : "listing_override", coverage, unresolved_default_adapters:supplied.unresolved };
}
