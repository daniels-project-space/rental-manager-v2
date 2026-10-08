import { stockOccupancyForItem, type Occupancy, type loadStockSources } from "./renter_stock";
import { repairHeldUnits } from "./availability";

import { londonStockInstant } from "./confirmed_schedule";
const coordinate = (value:string) => Date.parse(value+"Z");
const from = "0001-01-01", through = "9999-12-30";

/** Sparse, disjoint occupancy windows. Same-kit extensions use their maximum
 * units, matching stockWindowPeak; independent rentals still add together. */
export function stockWindows(occupancy:Occupancy[]) {
  const events = new Map<number,{id:number;group:string;qty:number;add:boolean}[]>();
  occupancy.forEach((row,id) => {
    if (row.end <= row.start || !Number.isSafeInteger(row.qty) || row.qty < 1) throw Error("Invalid shared occupancy");
    const group=row.extension_key ?? `independent:${id}`;
    for(const [at,add] of [[londonStockInstant(row.start,"start"),true],[londonStockInstant(row.end,"end"),false]] as const) {
      const values=events.get(at)??[];values.push({id,group,qty:row.qty,add});events.set(at,values);
    }
  });
  const groups=new Map<string,Map<number,number>>(), points=[...events.keys()].sort((a,b)=>a-b);
  const windows:{start:number;end:number;qty:number}[]=[];
  for(let i=0;i<points.length-1;i++) {
    for(const event of events.get(points[i])!) {
      const members=groups.get(event.group)??new Map<number,number>();
      if(event.add)members.set(event.id,event.qty);else members.delete(event.id);
      if(members.size)groups.set(event.group,members);else groups.delete(event.group);
    }
    const qty=[...groups.values()].reduce((sum,members)=>sum+Math.max(...members.values()),0);
    if(!qty)continue;
    const start=points[i],end=points[i+1];
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start)throw Error("Invalid shared stock dates");
    const prior=windows.at(-1);
    if(prior?.end===start&&prior.qty===qty)prior.end=end;else windows.push({start,end,qty});
  }
  return windows;
}

export function sharedStockSnapshot(sources:Awaited<ReturnType<typeof loadStockSources>>,checkedAt:number) {
  // Website bookings already occupy the website ledger. Importing their
  // manager copies would count the same physical allocation twice.
  const upstream={...sources,reservations:sources.reservations.filter(r=>r.account_slug!=="dbcinema_web")};
  return {version:2,checkedAt,units:sources.items.map(item=> {
    const active=item.status==="active"&&item.is_marketing_only===false;
    const quantityOwned=active&&Number.isSafeInteger(item.qty)&&item.qty>=0?item.qty:0;
    const occupancy=stockOccupancyForItem(upstream,item,{item_name:item.name_canonical,start_date:from,end_date:through});
    const repair=repairHeldUnits(sources.claims,item._id);
    if(repair)occupancy.push({start:from+"T00:00",end:"9999-12-31T00:00",qty:repair});
    for(const block of [...sources.blackouts.filter(b=>b.item_id===item._id),...sources.vacations]) {
      if(!quantityOwned)continue;
      const end=coordinate(block.end_date+"T00:00")+86400000;
      if(!Number.isSafeInteger(end))throw Error("Invalid shared blackout dates");
      occupancy.push({start:block.start_date+"T00:00",end:new Date(end).toISOString().slice(0,16),qty:quantityOwned});
    }
    return {masterItemId:String(item._id),active,quantityOwned,windows:stockWindows(occupancy)};
  })};
}
