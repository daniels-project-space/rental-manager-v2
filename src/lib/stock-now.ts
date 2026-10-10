/** Anonymous physical windows: no renter, account, order or evidence details. */
export type StockNowInput = {item_id:string;name:string;qty:number;inRepair:number;windows:Array<{start:number;end:number;qty:number;group?:number}>};
export function heldStockUnits(windows:StockNowInput["windows"],at:number){
 let independent=0;const groups=new Map<number,number>();
 for(const w of windows){
  if(w.start>at||w.end<=at)continue;
  if(w.group===undefined)independent+=w.qty;
  else groups.set(w.group,Math.max(groups.get(w.group)??0,w.qty));
 }
 return independent+[...groups.values()].reduce((sum,qty)=>sum+qty,0);
}
export function stockNowCard(inputs:StockNowInput[],at:number){
 const unavailable=inputs.flatMap(item=>{
  if(item.qty<1)return [];
  const heldNow=heldStockUnits(item.windows,at);
  return heldNow+item.inRepair>=item.qty?[{item_id:item.item_id,name:item.name,qty:item.qty,heldNow,inRepair:item.inRepair}]:[];
 });
 return {count:unavailable.length,items:unavailable.slice(0,15)};
}
