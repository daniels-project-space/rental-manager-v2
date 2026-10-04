import { recommendationRequirementsKey, type RecommendationRequirement } from "../../convex/lib/recommendation_qualification";
import { AsyncLocalStorage } from "node:async_hooks";

export type RenterScope = { threadId: string; accountSlug: string; requestMessageId?: string; bookingWritesAllowed?: boolean; rentalStage?: string; minimumRentalThreshold?:number; queryRevision?:()=>number; recommendationRequirements?:RecommendationRequirement[] };
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
