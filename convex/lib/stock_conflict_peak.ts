import type { Occupancy } from "./renter_stock";
import { londonStockInstant } from "./confirmed_schedule";
import { extensionOccupancyQty } from "./double_booking";
export const STOCK_CONFLICT_VERSION = 2;

/** Dashboard warnings use the same elapsed, buffered windows as checkout.
 * Pending requests are included in the possible peak, separately from the
 * confirmed-only peak. Window quantities preserve partial website returns. */
export function stockConflictPeak(rows: Array<Occupancy & {pending:boolean}>, start:string, end:string) {
  const from=londonStockInstant(start,"start"),to=londonStockInstant(end,"end");
  const windows=rows.map(row=>({...row,startAt:row.startInstant??londonStockInstant(row.start,"start"),endAt:row.endInstant??londonStockInstant(row.end,"end")}));
  const instants=[...new Set([from,...windows.map(r=>r.startAt).filter(t=>t>=from&&t<to)])].sort((a,b)=>a-b);
  const count=(active:typeof windows)=>extensionOccupancyQty(active.map(r=>({qty:r.qty,allocation_group:r.extension_key})));
  let peak=0,confirmedPeak=0,at:number|null=null;
  let overlapping:typeof windows=[];
  for(const t of instants){
    const active=windows.filter(r=>r.startAt<=t&&r.endAt>t);
    const quantity=count(active);
    if(quantity>peak){peak=quantity;at=t;overlapping=active;}
    confirmedPeak=Math.max(confirmedPeak,count(active.filter(r=>!r.pending)));
  }
  return {peak,confirmedPeak,at,overlapping};
}
