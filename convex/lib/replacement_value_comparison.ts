import {v,type Infer} from "convex/values";
import {selectNativeFinancialBlocks} from "./native_financial_blocks";
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
 const result=selectNativeFinancialBlocks(comparisons,savedText,text,replacementValueComparisonText);
 return {ok:result.ok,claim_text:result.claim_text,comparisons:result.selected};
}
