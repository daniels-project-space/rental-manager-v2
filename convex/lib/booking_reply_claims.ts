/** Shared generation/send-time interpretation of booking-state assertions. */
import {claimDateScope} from './claim_date_scope';
export type BookingDateAuthority={start_date?:string|null;end_date?:string|null};
/** Confirmation and acceptance belong to the current Native order's dates.
 * Stock checks for another span never extend that order's authority. */
export function unsupportedBookingDateClaims(text:string,dates:BookingDateAuthority,newInquiry=false) {
 return text.split(/(?<=[.!?])\s+|\n+/).filter(sentence=>{
  if(!claimsBookingConfirmation(sentence)&&!claimsCurrentOwnerApproval(sentence))return false;
  const scope=claimDateScope(sentence,dates.start_date);
  if(newInquiry&&/\b(?:new|next|separate|another)\s+(?:booking|rental|hire|request|order)\b/i.test(sentence))return true;
  if(!scope.explicit)return newInquiry&&!/\b(?:current|existing|original)\s+(?:booking|rental|hire|request|order)\b/i.test(sentence);
  if(!scope.valid||!scope.start_date||!scope.end_date||!dates.start_date||!dates.end_date)return true;
  return scope.start_date===scope.end_date
   ? scope.start_date<dates.start_date||scope.end_date>dates.end_date
   : scope.start_date!==dates.start_date||scope.end_date!==dates.end_date;
 });
}
export function assertsOutsideConditional(text: string, assertion: RegExp): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/).some(sentence => {
    const match = assertion.exec(sentence);
    if (!match) return false;
    return !/\b(?:once|when|after|if|until|as soon as|the moment|the second)\b[^,;:]{0,100}$/i.test(sentence.slice(0, match.index));
  });
}
export function claimsCurrentOwnerApproval(text: string): boolean {
  const assertion = /\byour\s+(?:already\s+)?booked\s+(?:kit|rental|booking|order|camera|lens|gear)\b|\byour\b[^.!?]{0,90}\b(?:is|has been)\s+(?:(?:now|already|fully)\s+)*booked\b(?!\s*(?:[-–—]\s*)?out\b|\s+by\s+(?:another|someone else))|\b(?:it|that)(?: is|\'s|’s)\s+booked\s+for\s+you\b|\b(?:(?:(?:your|the|this)\s+)?(?:booking|request|order)|it)\s*(?:is|has been|'s|’s)\s*(?:(?:now|already|fully)\s+)*(?:approved|accepted|confirmed)\b|\bI(?:'ve|’ve| have)\s+(?:just\s+)?(?:approved|accepted|confirmed)\b|\b(?:accepted|approved|confirmed)\s+(?:your|the)\s+(?:booking|request|order)\b/i;
  return assertsOutsideConditional(text, assertion);
}
export function claimsBookingConfirmation(text:string) {
  return assertsOutsideConditional(text,/\b(?:(?:(?:your|the|this)\s+)?(?:(?:new|next)\s+)?(?:booking|rental|request|order)|it)\s*(?:is|has been|'s|’s)\s*(?:(?:now|already|fully)\s+)*(?:confirmed|booked|secured|locked in|all set)\b|\byou(?:'re|’re| are)\s+(?:all\s+)?(?:booked|confirmed|set|good to go|locked in)\b|\b(?:confirmed|booked)\s+(?:your|the|this)\s+(?:booking|request|order|rental)\b/i);
}
const normal=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
/** Known private details are disclosures even inside a negative/conditional.
 * A delivery address supplied by the renter is not a pickup-location assertion. */
export function hasPickupDisclosure(text:string,sources:string[]=[]):boolean {
 const value=` ${normal(text)} `;
 const fragments=sources.flatMap(source=>[source,...source.split(/[\n,]/),...(source.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi)??[])]).map(normal)
  .filter(part=>part.length>=4&&!/^(?:central london|london|uk|united kingdom|england)$/.test(part));
 if(fragments.some(part=>value.includes(` ${part} `)))return true;
 return text.split(/(?<=[.!?])\s+|\n+/).some(sentence=>/\b(?:pick\s*up|pickup|collect(?:ion)?|meet|return|drop[ -]?off)\b/i.test(sentence) &&
  (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(sentence)||/\b\d+[a-z]?\s+(?:[a-z]+\s+){0,4}(?:street|road|avenue|lane|square|mall|place|drive|close|way)\b/i.test(sentence)));
}
export function pickupPrivacySources(profile:{pickup_address?:string|null;hub_postcode?:string|null;hub_label?:string|null}|null|undefined) {
 return [profile?.pickup_address,profile?.hub_postcode,profile?.hub_label].filter((value):value is string=>!!value?.trim());
}
