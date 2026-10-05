import { recommendationRequirementsKey, type RecommendationRequirement } from "../../convex/lib/recommendation_qualification";
import {sameRentalRequest,type RentalRequest} from "../../convex/lib/rental_request";
import { AsyncLocalStorage } from "node:async_hooks";

export type RenterScope = { threadId: string; accountSlug: string; requestMessageId?: string; rentalRequest?:RentalRequest; bookingWritesAllowed?: boolean; rentalStage?: string; minimumRentalThreshold?:number; queryRevision?:()=>number; queryReadRevision?:(value:unknown)=>number|undefined; recommendationRequirements?:RecommendationRequirement[] };
const storage = new AsyncLocalStorage<RenterScope>();
export const withRenterToolScope = <T>(scope: RenterScope, run: () => T): T => storage.run(scope, run);
export const currentRenterToolScope = () => storage.getStore();

/** The model chooses dates/items; server context owns thread and account. */
export function bindRenterToolArgs(functionName: string, args: Record<string, unknown>, scope = storage.getStore()) {
  if (!scope) return args;
  if (["renter_bot_lab_order:applyChange", "renter_bot_lab_order:applyAdditionBasket", "renter_bot_lab_order:applyReplacementBasket","renter_bot_lab_order:redeemReferral"].includes(functionName) && scope.bookingWritesAllowed === false) {
    throw new Error("Booking changes are disabled for this diagnostic candidate");
  }
  const bound = { ...args };
  if (["knowledge:getTemplate", "knowledge:search"].includes(functionName)) {
    bound.threadId = scope.threadId;
    bound.accountSlug = scope.accountSlug;
  }
  if ("account_slug" in args || functionName === "renter_bot_tools:lookup_pricing") bound.account_slug = scope.accountSlug;
  if ("hygglo_order_id" in args) bound.hygglo_order_id = scope.threadId;
  if ("thread_id" in args || ["renter_bot_tools:check_availability","renter_bot_tools:check_basket_availability","renter_bot_tools:find_owned_alternatives"].includes(functionName)) bound.thread_id = scope.threadId;
  if (["renter_bot_lab_order:applyChange", "renter_bot_lab_order:applyAdditionBasket", "renter_bot_lab_order:applyReplacementBasket","renter_bot_lab_order:redeemReferral"].includes(functionName)) bound.request_message_id = scope.requestMessageId ?? "";
  if (["renter_bot_tools:get_negotiation_stance","renter_bot_tools:select_rental_request"].includes(functionName)) {
    delete bound.rental_request;
    if(scope.rentalRequest)bound.rental_request=scope.rentalRequest;
  }
  return bound;
}

/** Only structured Native search results enter the request ledger. Later
 * weaker searches cannot erase previously checked hard requirements. */
export function recordRecommendationRequirements(scope:RenterScope|undefined,result:unknown) {
 if(!scope||!result||typeof result!=="object"||Array.isArray(result))return;
 const r=result as Record<string,unknown>,kind=r.kind==="camera_body"?"camera":r.kind;
 const requirements=kind==="camera"?r.camera_requirements:kind==="lens"?r.lens_requirements:null;
 if(!requirements||typeof requirements!=="object"||Array.isArray(requirements))return;
 const native_mount=typeof r.required_native_mount==="string"&&r.required_native_mount.trim()?r.required_native_mount:undefined;
 if(!native_mount&&!Object.values(requirements).some(v=>v!==undefined&&(!Array.isArray(v)||v.length)))return;
 const check=r.owner_check as {quantity?:number}|null;
 const quantity=typeof r.requested_quantity==="number"?r.requested_quantity:check?.quantity??1;
 const target_item_id=typeof r.target_item_id==="string"?r.target_item_id:undefined;
 const next={kind,requirements,native_mount,target_item_id,quantity} as RecommendationRequirement;
 const ledger=scope.recommendationRequirements??(scope.recommendationRequirements=[]);
 if(!ledger.some(c=>recommendationRequirementsKey([c])===recommendationRequirementsKey([next])))ledger.push(structuredClone(next));
}

/** Only the Native planner result can change this turn's request context.
 * Hard requirements are local to a hire; switching clears them in place so
 * drafting, retries and quote rendering continue sharing the same ledger. */
export function recordRentalRequest(scope:RenterScope|undefined,result:{rental_request:RentalRequest;request_message_id:string}){
 if(!scope||result.request_message_id!==scope.requestMessageId)throw new Error("Rental request planning is stale or unbound");
 if(!scope.rentalRequest||!sameRentalRequest(scope.rentalRequest,result.rental_request))scope.recommendationRequirements?.splice(0);
 scope.rentalRequest=structuredClone(result.rental_request);
}
