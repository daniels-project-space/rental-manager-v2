import { describe,expect,it } from "vitest";
import { groupLogicalRentals,renterPeriodGroupIds,logicalGroupIds } from "./predicates";
const rows=(slug:string)=>[1,2].map(n=>({_id:`row${n}`,_creationTime:n,expanded_items:[{item_id:"physical-camera",qty:1}],hygglo_order_id:`paid-booking-${n}`,account_slug:slug,renter_id:'same-person',renter_name:'Same person',status:'confirmed',start_date:'2035-01-01',end_date:'2035-01-03',items:[{item_name:'Sony FX3',qty:1}]}));
describe('website booking identities in grouping',()=>{
 it('keeps separately paid website bookings separate for returns, calendar dates and equipment quantities',()=>{
  const bookings=rows('dbcinema_web');expect(groupLogicalRentals(bookings)).toHaveLength(2);expect(new Set(renterPeriodGroupIds(bookings).values()).size).toBe(2);expect(new Set(logicalGroupIds(bookings).values()).size).toBe(2);
 });
 it('preserves existing same-renter Hygglo grouping',()=>{
  const bookings=rows('leo');expect(groupLogicalRentals(bookings)).toHaveLength(1);expect(new Set(renterPeriodGroupIds(bookings).values()).size).toBe(1);
 });
});
