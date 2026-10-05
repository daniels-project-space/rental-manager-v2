import {v,type Infer} from "convex/values";
const item=v.object({item_id:v.string(),name:v.string(),value_gbp:v.number()});
export const replacementValueComparisonValidator=v.object({value_key:v.string(),alternative:item,original:item});
export type ReplacementValueComparison=Infer<typeof replacementValueComparisonValidator>;
const validItem=(i:ReplacementValueComparison["original"])=>!!i.item_id&&!!i.name.trim()&&!/[\r\n]/.test(i.name)&&Number.isFinite(i.value_gbp)&&i.value_gbp>0&&Math.abs(i.value_gbp*100-Math.round(i.value_gbp*100))<0.000001;
export function replacementValueComparisonText(c:ReplacementValueComparison):string|null {
 if(!/^value_[a-f0-9]{32}$/.test(c.value_key)||!validItem(c.original)||!validItem(c.alternative)||c.original.item_id===c.alternative.item_id||c.alternative.value_gbp>=c.original.value_gbp)return null;
 const money=(n:number)=>`£${n.toLocaleString("en-GB",{minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2})}`;
 return `Recorded equipment replacement values per item:\n- ${c.alternative.name}: ${money(c.alternative.value_gbp)}\n- ${c.original.name}: ${money(c.original.value_gbp)}`;
}
/** Exact Native value blocks are information, not rental quotes or offers.
 * Never strip an edited amount, repeated block or free-form financial claim. */
export function replacementValueComparisonsForText(comparisons:ReplacementValueComparison[]|undefined,savedText:string|undefined,text:string) {
 let claim_text=text;const selected:ReplacementValueComparison[]=[];const seen=new Set<string>();
 const count=(s:string,part:string)=>s.split(part).length-1;
 for(const c of comparisons??[]){
  const block=replacementValueComparisonText(c);
  if(!block||seen.has(block)||!savedText||count(savedText,block)!==1||count(text,block)>1)return {ok:false,claim_text:text,comparisons:[]};
  seen.add(block);
  if(count(text,block)===1){selected.push(c);claim_text=claim_text.replace(block,"");}
 }
 return {ok:true,claim_text,comparisons:selected};
}
