import {describe,it,expect} from 'vitest';
import {claimsBookingConfirmation,claimsCurrentOwnerApproval,hasPickupDisclosure,unsupportedBookingDateClaims} from './booking_reply_claims';
import {rentalStage,rentalReplyPermissions} from './rental_stage';
import {guardDraft} from './draft_guard';
const address='12 Example Road, London, W1A 1AA';
describe('current rental reply permissions',()=>{
 it('does not transfer current confirmation to an undated separate inquiry',()=>{
  const dates={start_date:'2026-10-08',end_date:'2026-10-09'};
  for(const text of ['Your new rental is confirmed.','Your booking is approved.','You are booked.','Your new rental is confirmed for 8 to 9 October.'])expect(unsupportedBookingDateClaims(text,dates,true)).toEqual([text]);
  for(const text of ['Your current rental is confirmed.','Your booking is confirmed for 8 to 9 October.','The new rental is not confirmed.','Once your booking is confirmed I can arrange collection.'])expect(unsupportedBookingDateClaims(text,dates,true)).toEqual([]);
 });
 it('does not lend an existing confirmed order to a different dated hire',()=>{
  const dates={start_date:'2026-10-08',end_date:'2026-10-09'};
  const permissions=rentalStage({status:'confirmed',start_date:dates.start_date,end_date:dates.end_date},'2026-10-04');
  expect(permissions.can_confirm_booking).toBe(true);
  expect(permissions.booking_dates).toEqual(dates);
  for(const text of ['Your new rental is confirmed for 22 to 24 October.','Your booking is approved for 2026-10-22 to 2026-10-24.','You are booked for 8 to 10 October.','Your rental is confirmed for 31 February 2026.']){
   expect(unsupportedBookingDateClaims(text,dates)).toEqual([text]);
   expect(guardDraft(text,{history:[],lastRenterMessage:'Quote a separate new hire.',stage:permissions.stage,rentalPermissions:permissions}).flags.some(f=>f.type==='PREMATURE_CONFIRMATION')).toBe(true);
  }
  for(const text of ['Your booking is confirmed for 8 to 9 October.','You are booked for 8 October.','Your booking is approved for 2026-10-08 to 2026-10-09.','Your current rental is confirmed for 8 to 9 October. The new enquiry for 22 to 24 October is not confirmed.','Once your rental is confirmed for 22 to 24 October I can arrange collection.'])expect(unsupportedBookingDateClaims(text,dates)).toEqual([]);
 });
 it('requires original date authority rather than a stock or quote span',()=>{
  const text='Your new rental is confirmed for 22 to 24 October.';
  expect(unsupportedBookingDateClaims(text,{})).toEqual([text]);
  const permissions=rentalStage({status:'confirmed',start_date:'2026-10-08',end_date:'2026-10-09'},'2026-10-04');
  expect(guardDraft(text,{history:[],lastRenterMessage:'Quote only.',stage:permissions.stage,rentalPermissions:permissions,stockRequest:{start_date:'2026-10-22',end_date:'2026-10-24',items:[]}}).flags.some(f=>f.type==='PREMATURE_CONFIRMATION')).toBe(true);
 });
 it('retains historical confirmation without granting a new booking or pickup permission',()=>{
  const stage=rentalStage({status:'completed',order_step:'REVIEWED'},'2026-10-04');
  expect(stage).toMatchObject({stage:'COMPLETED',booking_confirmed:true,can_confirm_booking:false,can_share_pickup_address:false});
  for(const value of ['COMPLETED','CANCELLED','VERIFICATION_FAILED','INQUIRY','UNCONFIRMED','AWAITING_OWNER_APPROVAL','AWAITING_PAYMENT','AWAITING_VERIFICATION'])expect(rentalReplyPermissions(value).can_share_pickup_address).toBe(false);
  for(const value of ['CONFIRMED_UPCOMING','COLLECTION_DUE','IN_USE','RETURN_OVERDUE'])expect(rentalReplyPermissions(value).can_share_pickup_address).toBe(true);
  const inconsistent=rentalStage({status:'pending_review',order_step:'RETURNED'},'2026-10-04');
  expect(inconsistent.can_confirm_booking).toBe(false);
  expect(guardDraft('Your booking is confirmed.',{history:[],lastRenterMessage:'Confirmed?',stage:inconsistent.stage,rentalPermissions:inconsistent}).flags.some(f=>f.type==='PREMATURE_CONFIRMATION')).toBe(true);
 });
 it('distinguishes a truthful history and future deferral from a current confirmation',()=>{
  for(const text of ['Your booking is confirmed.','Your new booking is confirmed.','You are booked.'])expect(claimsBookingConfirmation(text)).toBe(true);
  for(const text of ['The previous rental was confirmed and is now completed.','I can send the exact address once your booking is confirmed.','Your booking is not confirmed.'])expect(claimsBookingConfirmation(text)).toBe(false);
  expect(claimsBookingConfirmation('Once your booking is confirmed I can send the address. Your booking is confirmed.')).toBe(true);
  expect(claimsCurrentOwnerApproval('Your booking is approved.')).toBe(true);
  expect(claimsCurrentOwnerApproval('I can send the address the moment your booking is approved.')).toBe(false);
 });
 it('keeps current confirmations out of a closed chat despite its historical owner approval',()=>{
  const opts={history:[],lastRenterMessage:'Can I rent again?',stage:'COMPLETED',ownerApproved:true};
  expect(guardDraft('Your new booking is confirmed.',opts).flags.some(f=>f.type==='PREMATURE_CONFIRMATION')).toBe(true);
  expect(guardDraft('Your booking is approved.',opts).flags.some(f=>f.type==='FALSE_ACTION_CLAIM')).toBe(true);
  expect(guardDraft('The previous rental was completed. The new enquiry is not yet confirmed.',opts).flags.some(f=>['PREMATURE_CONFIRMATION','FALSE_ACTION_CLAIM'].includes(f.type))).toBe(false);
 });
 it('recognizes configured private detail fragments and independent pickup address claims',()=>{
  for(const text of [`Collect from ${address}.`,'The address is 12 Example Road.','It is not at W1A 1AA.'])expect(hasPickupDisclosure(text,[address])).toBe(true);
  expect(hasPickupDisclosure('Collect at 17 Another Street, SW1A 1AA.')).toBe(true);
  expect(hasPickupDisclosure('Delivery to your W1A 2AB postcode needs a location check.')).toBe(false);
  expect(hasPickupDisclosure('Pickup is in central London. I can send the exact address once confirmed.',[address,'central London'])).toBe(false);
 });
 it('uses the same disclosure predicate in the generation guard without forbidding a real return',()=>{
  const text=`You can collect from ${address}.`,opts={history:[],lastRenterMessage:'Where do I collect?',pickupPrivacySources:[address]};
  expect(guardDraft(text,{...opts,stage:'COMPLETED'}).flags.some(f=>f.type==='PICKUP_DETAILS_EARLY')).toBe(true);
  expect(guardDraft(text,{...opts,stage:'CONFIRMED_UPCOMING'}).flags.some(f=>f.type==='PICKUP_DETAILS_EARLY')).toBe(false);
  expect(guardDraft(`Return it to ${address}.`,{...opts,stage:'IN_USE'}).flags.some(f=>f.type==='PICKUP_DETAILS_EARLY')).toBe(false);
 });
});
