import { describe,expect,it } from "vitest";
import { isInventoryCommittedWithDates,groupLogicalRentals,renterPeriodGroupIds,logicalGroupIds } from "./predicates";
const rows=(slug:string)=>[1,2].map(n=>({_id:`row${n}`,_creationTime:n,expanded_items:[{item_id:"physical-camera",qty:1}],hygglo_order_id:`paid-booking-${n}`,account_slug:slug,renter_id:'same-person',renter_name:'Same person',status:'confirmed',start_date:'2035-01-01',end_date:'2035-01-03',items:[{item_name:'Sony FX3',qty:1}]}));
describe('website booking identities in grouping',()=>{
 it('keeps separately paid website bookings separate for returns, calendar dates and equipment quantities',()=>{
  const bookings=rows('dbcinema_web');expect(groupLogicalRentals(bookings)).toHaveLength(2);expect(new Set(renterPeriodGroupIds(bookings).values()).size).toBe(2);expect(new Set(logicalGroupIds(bookings).values()).size).toBe(2);
 });
 it('preserves existing same-renter Hygglo grouping',()=>{
  const bookings=rows('leo');expect(groupLogicalRentals(bookings)).toHaveLength(1);expect(new Set(renterPeriodGroupIds(bookings).values()).size).toBe(1);
 });
});


it('inventory commitments include only confirmed dates or paid website verification and never change the revenue predicate',()=>{
 const base={_id:'web',_creationTime:1,account_slug:'dbcinema_web',status:'pending_review',order_step:'VERIFIED',start_date:'2035-01-01',end_date:'2035-01-02'};
 expect(isInventoryCommittedWithDates(base)).toBe(true);
 for(const patch of [{account_slug:'leo'},{order_step:'FUNDS_RESERVED'},{status:'cancelled'},{status:'completed'},{is_obsolete:true},{end_date:undefined}])expect(isInventoryCommittedWithDates({...base,...patch})).toBe(false);
 expect(isInventoryCommittedWithDates({...base,status:'confirmed',order_step:'BOOKED_AFTER_VERIFIED'})).toBe(true);
});
