import type {Doc} from "../_generated/dataModel";
import {inventorySpecMap,ownedInventoryItem} from "./inventory_spec_grounding";
import {verifiedCameraCapabilities} from "./camera_requirements";
import {verifiedLensCapabilities} from "./lens_requirements";
import {verifiedItemSpec} from "./verified_item_spec";
import {renterItemNames,reviewedLensNames} from "./renter_item_names";
export function equipmentClaimsNeedProfiles(text:string) {
 return /\b4k(?:\b|\d{2,3}(?:p|fps)\b)|\b(?:built[ -]?in|internal)\s+(?:variable\s+)?NDs?\b|\b(?:auto[- ]?focus|manual[- ]focus|AF)\b/i.test(text);
}
/** Current owned profiles only. Duplicate reviews cannot select a convenient
 * record. This shared projection is used before generation and before send. */
export function equipmentClaimProfiles(items:Doc<"items">[],specs:Doc<"item_specs">[]) {
 const byItem=inventorySpecMap(specs),cameras=[],lenses=[];
 for(const item of items.filter(ownedInventoryItem)) {
  const spec=byItem.get(String(item._id));
  if(["camera","camera_body"].includes(item.kind??"")) {
   const capabilities=verifiedCameraCapabilities(spec,item.name_canonical);
   if(capabilities)cameras.push({names:[item.name_canonical,...(item.aliases??[]),spec!.verified_model!,
    ...(item.name_canonical.startsWith("Sony ")?[item.name_canonical.slice(5)]:[])].flatMap(renterItemNames),capabilities});
  } else if(item.kind==="lens") {
   const capabilities=verifiedLensCapabilities(spec,item.name_canonical),verified=verifiedItemSpec(spec,item.name_canonical);
   lenses.push({names:reviewedLensNames({name:item.name_canonical,kind:"lens",lens_capabilities:capabilities,spec_verification:verified}),capabilities});
  }
 }
 return {cameras,lenses};
}
