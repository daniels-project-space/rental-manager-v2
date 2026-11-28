import type {Doc} from "../_generated/dataModel";
import type {QueryCtx} from "../_generated/server";
import {baseListingProductIds} from "./base_listing_identity";
import {listingMediaConflict,withoutUnverifiedMediaCapacity} from "./listing_media_conflict";
import {canonicalKitContents,type KitComponent} from "./canonical_kit_contents";

type KitSources={indexes:Doc<"hygglo_product_index">[];overrides:Doc<"listing_resolution_override">[];peers:Doc<"online_listings">[]};

/** One Native interpretation for renter context and owner-task revalidation.
 * A complete stock mapping does not resolve conflicting supplied contents. */
export async function listingKitContext(ctx:QueryCtx,account:string|null|undefined,item:Doc<"items">|undefined,
  components:KitComponent[],inventory:Doc<"items">[],sources?:KitSources,productId?:number) {
  let recorded=item?.compatibility?.included_with_rental??[];
  let safe=recorded,conflict=false;
  let listingNames:string[]=[];
  let ownerConfirmed:Doc<"listing_resolution_override">["owner_confirmed_kit_contents"];
  if(item&&account&&["camera","camera_body"].includes(item.kind??"")){
    const [indexes,overrides,peers]=sources?[sources.indexes,sources.overrides,sources.peers]:await Promise.all([
      ctx.db.query("hygglo_product_index").withIndex("by_item_id",q=>q.eq("item_id",item._id)).collect(),
      ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account)).collect(),
      ctx.db.query("online_listings").withIndex("by_account",q=>q.eq("account_slug",account)).collect(),
    ]);
    ownerConfirmed=ownerConfirmedContentsForListing(overrides,account,productId,String(item._id),components);
    if(ownerConfirmed) recorded=ownerConfirmed.lines;
    const ids=baseListingProductIds(account,String(item._id),indexes,overrides,inventory,peers);
    listingNames=peers.filter(p=>ids.includes(p.product_id)).map(p=>p.name??"");
    conflict=!ownerConfirmed&&listingMediaConflict(recorded,listingNames);
    if(conflict)safe=withoutUnverifiedMediaCapacity(recorded);
  }
  const reviewedForItem=item?components.filter(c=>String(c.item_id)===String(item._id)).flatMap(c=>c.reviewed_supplied_parts??[]):[];
  const reviewedLines=reviewedForItem.map(p=>`${p.qty}x ${p.name}`);
  const kit=canonicalKitContents(components,inventory,safe,item?String(item._id):undefined,ownerConfirmed?.lines);
  const includedWithRental=ownerConfirmed?.lines??(reviewedLines.length
    ? reviewedLines.filter(text=>!kit.unreconciled_contents.includes(text))
    : safe.filter(text=>!kit.unreconciled_contents.includes(text)));
  const itemManifest=item?.owner_verified_kit;
  const itemManifestApplies=!!itemManifest?.source.trim()&&itemManifest.contents.length===includedWithRental.length&&
    itemManifest.contents.every((line,index)=>line.trim()===includedWithRental[index]?.trim());
  const contents_review_required=conflict||kit.unreconciled_contents.length>0;
  return {kit,included_with_rental:includedWithRental,contents_review_required,
    included_with_rental_source:ownerConfirmed?.source??(itemManifestApplies?itemManifest!.source:null),
    included_with_rental_recorded_at:ownerConfirmed?.recorded_at??(itemManifestApplies?item?.updated_at??null:null),
    contents_review:contents_review_required?{recorded_contents:recorded,listing_names:listingNames,unreconciled_contents:kit.unreconciled_contents}:null};
}

/** Owner contents are usable only for the exact account/listing and exact
 * physical mapping that was confirmed. This prevents one bundle's pack list
 * from becoming a claim about another offer for the same shared body. */
export function ownerConfirmedContentsForListing(
  overrides:Doc<"listing_resolution_override">[],account:string,productId:number|undefined,itemId:string,
  components:KitComponent[],
) {
  if(productId===undefined)return undefined;
  const override=overrides.find(row=>row.account_slug===account&&row.product_id===productId);
  const evidence=override?.owner_confirmed_kit_contents;
  if(!override||!evidence||!evidence.lines.length||!evidence.source.trim())return undefined;
  const normalize=(rows:Array<{item_id:string;qty:number}>)=>rows.map(row=>({item_id:String(row.item_id),qty:row.qty}))
    .sort((a,b)=>a.item_id.localeCompare(b.item_id));
  const same=(a:Array<{item_id:string;qty:number}>,b:Array<{item_id:string;qty:number}>)=>{
    const left=normalize(a),right=normalize(b);
    return left.length===right.length&&left.every((row,index)=>row.item_id===right[index]?.item_id&&row.qty===right[index]?.qty);
  };
  const saved=normalize(evidence.mapping_components);
  const current=normalize(override.components);
  const selected=components.flatMap(component=>component.item_id?[
    {item_id:String(component.item_id),qty:component.units_per_listing},
  ]:[]);
  // Listing resolution may enrich the explicit override with accessories
  // parsed from seller text. That derived expansion is not a change to the
  // owner-verified physical mapping. Require every explicit mapped component
  // to remain present at the same quantity, while allowing extra derived
  // components; the exact owner manifest replaces those weaker text claims.
  const mappingStillPresent=current.every(component=>selected.some(candidate=>
    candidate.item_id===component.item_id&&candidate.qty===component.qty));
  if(!current.some(component=>component.item_id===itemId)||!same(saved,current)||!mappingStillPresent)return undefined;
  return evidence;
}

export function listingKitItem(physical:{primary_camera?:{item_id:string}|null;components:Array<{item_id:string;kind:string|null;stock_required:boolean}>},inventory:Doc<"items">[]) {
  const main=physical.primary_camera??physical.components.find(c=>["camera","camera_body"].includes(c.kind??""))??physical.components.find(c=>c.stock_required);
  return main?inventory.find(i=>String(i._id)===main.item_id):undefined;
}
