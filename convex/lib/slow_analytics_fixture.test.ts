/** Synthetic contract data only; never imported by an application module. */
export function slowAnalyticsFixture(now: number) {
  const day = (offset: number) => new Date(now - offset * 86400000).toISOString().slice(0,10);
  const items = [
    {_id:"camera",_creationTime:1,name_canonical:"Camera",kind:"camera",category:"camera",qty:2,status:"active",is_marketing_only:false,acquisition_cost_gbp:100,created_at:now-900*86400000},
    {_id:"lens",_creationTime:2,name_canonical:"Lens",kind:"lens",category:"lens",qty:1,status:"active",is_marketing_only:false,acquisition_cost_gbp:80,created_at:now-900*86400000},
    {_id:"marketing",_creationTime:3,name_canonical:"Marketing",qty:1,status:"active",is_marketing_only:true,acquisition_cost_gbp:200},
    {_id:"retired",_creationTime:4,name_canonical:"Retired",qty:0,status:"inactive",is_marketing_only:false,acquisition_cost_gbp:null},
  ];
  const pricing_catalog = [
    {_id:"p1",_creationTime:1,item_id:"camera",item_name_canonical:"Camera",daily_price_min:10,created_at:1,is_bundle:false,marketing_only:false},
    {_id:"p2",_creationTime:2,item_id:"lens",item_name_canonical:"Lens",daily_price_min:8,created_at:2,is_bundle:false,marketing_only:false},
    {_id:"p3",_creationTime:3,item_id:"camera",item_name_canonical:"Camera",daily_price_min:12,created_at:3,is_bundle:false,marketing_only:false},
  ];
  const offsets=[1,2,3,5,29,30,31,60,89,90,91,364,365,366,729,730,731];
  const reservations=["leo","diogo","dbcinema","dbcinema_web"].flatMap((account,accountIndex)=>offsets.map((offset,index)=>({
    _id:`r${accountIndex}:${index}`,_creationTime:1000+accountIndex*100+index,
    account_slug:account,status:index%7===0?"cancelled":index%7===1?"denied":index%2?"confirmed":"completed",
    start_date:day(offset),pickup_date:day(offset),end_date:day(offset-2),return_date:day(offset-2),
    duration_days:2,gross_paid_gbp:[0.1,0.2,10.1,125.375][index%4],net_to_owner_gbp:5.05,
    order_step:"RETURNED",paid:true,platform_booking_confirmed:true,
    hygglo_order_id:`order${accountIndex}:${index}`,renter_id:`renter${accountIndex}`,
    items:[{item_id:"camera",item_name:"Camera",qty:1},{item_id:"lens",item_name:"Lens",qty:1}],
    resolved_items:[{item_id:"camera",item_name_canonical:"Camera",qty:1},{item_id:"lens",item_name_canonical:"Lens",qty:1}],
  })));
  return {capturedAt:now,tables:{items,pricing_catalog,reservations,bundles:[{_id:"kit",_creationTime:1,bundle_name:"Camera kit"}],bundle_items:[{_id:"bi1",_creationTime:1,bundle_id:"kit",item_name_canonical:"Camera",qty:1},{_id:"bi2",_creationTime:2,bundle_id:"kit",item_name_canonical:"Lens",qty:1}],listing_resolution_override:[]}};
}
