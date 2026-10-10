import {heldStockUnits,type StockNowInput} from "./stock-now";
export const STOCK_FORECAST_VERSION=1;
export type StockForecastInput=StockNowInput&{image:string|null};
export type StockForecastSnapshot={stockWindowVersion:number;horizonEnd:number;inputs:StockForecastInput[]};
export type StockForecastRow={itemId:string;name:string;image:string|null;nextAvailableDate:string|null;nextAvailableAt:number|null;blockedFromAt:number;currentlyUnavailable:boolean;activeReservationCount:number;ownedUnits:number;inRepair:number;forecastInput:StockForecastInput;horizonEnd:number};
const londonDate=(at:number)=>{const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;};

/** Forecast the first fully committed period and the next free unit. Distinct
 * non-overlapping hires cannot combine to manufacture an unavailable kit. */
export function stockForecastRows(snapshot:StockForecastSnapshot,now:number):StockForecastRow[]{
 return snapshot.inputs.flatMap(item=>{
  if(item.qty<1)return [];
  const boundaries=[...new Set([now,...item.windows.flatMap(w=>[w.start,w.end]).filter(t=>t>now)])].sort((a,b)=>a-b);
  const capacity=item.qty-item.inRepair;
  const blocked=boundaries.find(t=>t<snapshot.horizonEnd&&heldStockUnits(item.windows,t)>=capacity);
  if(blocked===undefined)return [];
  const peak=Math.max(...boundaries.filter(t=>t>=now&&t<snapshot.horizonEnd).map(t=>heldStockUnits(item.windows,t)));
  const free=capacity<=0?undefined:boundaries.find(t=>t>blocked&&heldStockUnits(item.windows,t)<capacity);
  return [{itemId:item.item_id,name:item.name,image:item.image,nextAvailableDate:free===undefined?null:londonDate(free),nextAvailableAt:free??null,blockedFromAt:blocked,currentlyUnavailable:blocked===now,activeReservationCount:peak,ownedUnits:item.qty,inRepair:item.inRepair,forecastInput:item,horizonEnd:snapshot.horizonEnd}];
 });
}
