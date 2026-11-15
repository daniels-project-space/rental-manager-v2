import { assessTravelCompensation, mentionsPickupArea, type TravelCompensationTurn } from "./travel_compensation";

const DAY=24*60*60*1000;
export type LabTurn=TravelCompensationTurn & { at:number; messageId:string };

/** Only locally simulated bookings. `confirmedAt` must be a saved confirmation
 * event, never the most recent poll or a model guess. */
export function missingTimeDraft(input:{now:number;confirmedAt:number|null;confirmed:boolean;startDate:string;endDate:string;pickupConfirmed:boolean;returnConfirmed:boolean}):string|null {
 const validDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date;
 const today=new Date(input.now).toLocaleDateString("en-CA",{timeZone:"Europe/London"});
 if(!input.confirmed || input.confirmedAt==null || !Number.isFinite(input.confirmedAt) || input.now<input.confirmedAt+DAY ||
  !validDate(input.startDate) || !validDate(input.endDate) || input.endDate<input.startDate || input.endDate<today ||
  (input.pickupConfirmed && input.returnConfirmed))return null;
 const requested=!input.pickupConfirmed && !input.returnConfirmed ? "pickup and return times" : !input.pickupConfirmed ? "pickup time" : "return time";
 return `Hi! Could you confirm your exact ${requested} within your rental dates and our opening hours?`;
}

/** Silence is not proof of a location objection. Require a prior explicit
 * concern, a subsequent account-area disclosure, and no later message. */
export function distanceFollowupDraft(input:{now:number;history:LabTurn[];pickupArea:string|null;rentalChargeGbp:number|null}):string|null {
 const last=input.history.at(-1);
 if(!last || last.role!=="owner" || !Number.isFinite(last.at) || input.now<last.at+DAY || !mentionsPickupArea(last.content,input.pickupArea))return null;
 const renter=[...input.history.slice(0,-1)].reverse().find(turn=>turn.role==="renter");
 if(!renter)return null;
 const assessment=assessTravelCompensation({history:input.history,lastRenterMessage:renter.content,pickupArea:input.pickupArea,rentalChargeGbp:input.rentalChargeGbp});
 if(!assessment.eligible || assessment.maximumGbp==null)return null;
 return `Hi! Following up about the collection journey: I can offer a one-time £${assessment.maximumGbp.toFixed(2)} travel adjustment on this rental if that helps.`;
}
