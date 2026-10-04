/** Operational state comes from the current reservation, never an LLM label.
 * Hygglo order_step is the NEXT action: RETURNED means return is still due.
 */
export const RENTAL_STAGES = ["INQUIRY", "AWAITING_OWNER_APPROVAL", "AWAITING_PAYMENT", "AWAITING_VERIFICATION", "CONFIRMED_UPCOMING", "COLLECTION_DUE", "IN_USE", "RETURN_OVERDUE", "COMPLETED", "CANCELLED", "VERIFICATION_FAILED", "UNCONFIRMED"] as const;
export type RentalStage = (typeof RENTAL_STAGES)[number];
export function isClosedRentalStage(stage:string|null|undefined) {
  return stage==="COMPLETED" || stage==="CANCELLED" || stage==="VERIFICATION_FAILED";
}
/** Historical completion is not permission for a new handover/booking. */
export function rentalReplyPermissions(stage:string) {
 const current=stage.toUpperCase();
 const confirmed=["CONFIRMED_UPCOMING","COLLECTION_DUE","IN_USE","RETURN_OVERDUE","CONFIRMED","ONGOING","UPCOMING","ACTIVE"].includes(current);
 return {can_confirm_booking:confirmed,can_share_pickup_address:confirmed,
  can_acknowledge_owner_acceptance:confirmed||["AWAITING_PAYMENT","AWAITING_VERIFICATION"].includes(current)};
}

export function rentalStage(row: {
  status?: string | null;
  order_step?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  pickup_date?: string | null;
  return_date?: string | null;
  is_obsolete?: boolean;
  awaiting_owner_action?: boolean;
} | null | undefined, today: string) {
  const status = row?.status?.toLowerCase();
  const step = row?.order_step;
  const end = row?.return_date ?? row?.end_date;
  const start = row?.pickup_date ?? row?.start_date;
  let stage: RentalStage;
  let guidance: string;
  if (!row) {
    stage = "INQUIRY";
    guidance = "Answer the current question, establish exact gear, quantity and dates when needed, recommend a relevant owned option using verified facts. Invite booking when they are ready. No exact pickup address or claim that a booking exists.";
  } else if (row.is_obsolete || ["cancelled", "canceled", "declined"].includes(status ?? "") || ["CANCELED", "VERIFICATION_FAILED"].includes(step ?? "")) {
    stage = step === "VERIFICATION_FAILED" ? "VERIFICATION_FAILED" : "CANCELLED";
    guidance = stage === "VERIFICATION_FAILED"
      ? "The platform's final verification failure cancelled this booking. Do not arrange collection, retry edits, promise approval or claim a refund was issued. Explain that a friend can make their own booking from their own account, taking responsibility and completing that booking's checks; they can mention the referral code to restore the basket with fresh availability and pricing. Do not share credentials or the original renter's personal verification details. Offer to check suitable lower-value owned equipment if helpful using find_owned_alternatives with lower_value_only=true and the exact physical item being replaced, preserving all required capabilities; lower value may change the checks but never guarantees approval. An existing verified account may need verification again."
      : "This order is no longer going ahead. Do not arrange collection or claim it is booked. Help with a new request if they want to try again; any disputed cancellation needs human review.";
  } else if (status === "completed" || step === "REVIEWED") {
    stage = "COMPLETED";
    guidance = "The return is complete. Answer after-rental questions, feedback or a new booking request. Do not arrange collection for this finished rental. Its historical confirmation does not confirm a new hire or permit new pickup details; a new request needs its own platform confirmation.";
  } else if (row.awaiting_owner_action === true || step === "REQUEST") {
    stage = "AWAITING_OWNER_APPROVAL";
    guidance = "The request awaits the owner's acceptance. Do not tell them to pay or verify yet, and do not claim approval happened. Owner acceptance alone does not establish a confirmed booking: the platform still determines payment and verification completion. Do not promise 'once accepted, your booking will be confirmed' or promise the exact pickup address immediately on acceptance. Share the address only after the platform reports confirmation. Prepare a helpful reply for human review.";
  } else if (["APPROVED", "FUNDS_RESERVED"].includes(step ?? "")) {
    stage = "AWAITING_PAYMENT";
    guidance = "The owner accepted, but the renter has not paid yet. If asked how to proceed, explain completing payment on the platform. Payment alone does not establish confirmation: verification and platform confirmation must also be complete. Do not say paid, confirmed, or arrange a secured collection.";
  } else if (step === "VERIFIED") {
    stage = "AWAITING_VERIFICATION";
    guidance = "Payment is funded but ID/document verification is still outstanding. Explain the remaining verification step when relevant. Do not claim verification or confirmation is complete.";
  } else if (step === "RETURNED" || status === "ongoing") {
    stage = end && end < today ? "RETURN_OVERDUE" : "IN_USE";
    guidance = "The gear is with the renter and still needs returning. Help with usage, problems, extensions or return arrangements. Never infer it was returned just because the booked end date passed.";
  } else if (status === "confirmed") {
    stage = start && start <= today ? "COLLECTION_DUE" : "CONFIRMED_UPCOMING";
    guidance = "The booking is confirmed. Give the exact account pickup details when asked and make the handover clear. A scheduled pickup date or active DELIVERED step alone does not prove that gear has been collected; do not say they already have it.";
  } else {
    stage = "UNCONFIRMED";
    guidance = "The order exists but its next required action is not verified. Do not invent a payment, approval or verification requirement. Answer from known facts and route consequential uncertainty to the owner.";
  }
  const confirmed = ["confirmed", "ongoing", "completed"].includes(status ?? "") && !row?.is_obsolete && row?.awaiting_owner_action !== true && !["CANCELED", "VERIFICATION_FAILED", "REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED"].includes(step ?? "");
  const permissions=rentalReplyPermissions(stage);
  return { stage, guidance, booking_confirmed: confirmed,
    booking_dates:{start_date:start??null,end_date:end??null},
    can_confirm_booking:confirmed&&permissions.can_confirm_booking,
    can_share_pickup_address:confirmed&&permissions.can_share_pickup_address,
    can_acknowledge_owner_acceptance:permissions.can_acknowledge_owner_acceptance&&
      (confirmed||["AWAITING_PAYMENT","AWAITING_VERIFICATION"].includes(stage)) };

}
