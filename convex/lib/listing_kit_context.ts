import type {Doc} from "../_generated/dataModel";
import type {QueryCtx} from "../_generated/server";
import {baseListingProductIds} from "./base_listing_identity";
import {listingMediaConflict,withoutUnverifiedMediaCapacity} from "./listing_media_conflict";
import {recordedKit} from "./recommendation_kit";

/** One Native interpretation for renter context and owner-task revalidation.
 * A complete stock mapping does not resolve conflicting supplied contents. */
export async function listingKitContext(ctx:QueryCtx,account:string|null|undefined,item:Doc<"items">|undefined,
  components:Array<{name:string|null;units_per_listing:number}>,inventory:Doc<"items">[]) {
  const recorded=item?.compatibility?.included_with_rental??[];
  let safe=recorded,conflict=false;
  let listingNames:string[]=[];
  if(item&&account&&["camera","camera_body"].includes(item.kind??"")){
    const [indexes,overrides,peers]=await Promise.all([
      ctx.db.query("hygglo_product_index").withIndex("by_item_id",q=>q.eq("item_id",item._id)).collect(),
      ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account)).collect(),
      ctx.db.query("online_listings").withIndex("by_account",q=>q.eq("account_slug",account)).collect(),
    ]);
    const ids=baseListingProductIds(account,String(item._id),indexes,overrides,inventory,peers);
    listingNames=peers.filter(p=>ids.includes(p.product_id)).map(p=>p.name??"");
    conflict=listingMediaConflict(recorded,listingNames);
    if(conflict)safe=withoutUnverifiedMediaCapacity(recorded);
  }
  const kit=recordedKit(components.map(c=>({name:c.name,qty:c.units_per_listing})),safe);
  const contents_review_required=conflict||kit.unreconciled_contents.length>0;
  return {kit,included_with_rental:safe.filter(text=>!kit.unreconciled_contents.includes(text)),contents_review_required,
    contents_review:contents_review_required?{recorded_contents:recorded,listing_names:listingNames,unreconciled_contents:kit.unreconciled_contents}:null};
}

export function listingKitItem(physical:{primary_camera?:{item_id:string}|null;components:Array<{item_id:string;kind:string|null;stock_required:boolean}>},inventory:Doc<"items">[]) {
  const main=physical.primary_camera??physical.components.find(c=>["camera","camera_body"].includes(c.kind??""))??physical.components.find(c=>c.stock_required);
  return main?inventory.find(i=>String(i._id)===main.item_id):undefined;
}
