import {v,type Infer} from "convex/values";
import {inclusiveRentalDays} from "./hygglo_pricing";
import {selectNativeFinancialBlocks} from "./native_financial_blocks";
const price=v.object({item_id:v.string(),name:v.string(),product_id:v.number(),total_gbp:v.number()});
export const budgetPriceCheckValidator=v.object({budget_key:v.string(),start_date:v.string(),end_date:v.string(),quantity:v.number(),max_total_gbp:v.number(),prices:v.array(price)});
export type BudgetPriceCheck=Infer<typeof budgetPriceCheckValidator>;
const amount=(n:number)=>Number.isFinite(n)&&n>0&&Math.abs(n*100-Math.round(n*100))<0.000001;
export function budgetPriceCheckText(check:BudgetPriceCheck):string|null{
 if(typeof check.start_date!=="string"||typeof check.end_date!=="string"||!Array.isArray(check.prices))return null;
 const days=inclusiveRentalDays(check.start_date,check.end_date);
 if(!/^budget_[a-f0-9]{32}$/.test(check.budget_key)||!days||days>366||!amount(check.max_total_gbp)||!Number.isInteger(check.quantity)||check.quantity<1||check.quantity>20||check.prices.length>8||
  new Set(check.prices.map(p=>p.item_id)).size!==check.prices.length||check.prices.some(p=>typeof p.item_id!=="string"||!p.item_id||typeof p.name!=="string"||!p.name.trim()||/[\r\n]/.test(p.name)||!Number.isInteger(p.product_id)||p.product_id<=0||!amount(p.total_gbp)))return null;
 const money=(n:number)=>`£${n.toFixed(2).replace(/\.00$/,"")}`;
 const date=(iso:string)=>new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${iso}T12:00:00Z`));
 const period=check.start_date===check.end_date?date(check.start_date):`${date(check.start_date)} to ${date(check.end_date)}`;
 return [`Hire budget comparison for ${days} ${days===1?"day":"days"} (${period}), ${check.quantity} ${check.quantity===1?"unit":"units"} of each listed option:`,
  `Maximum used for this search: ${money(check.max_total_gbp)}`,
  ...check.prices.map(p=>`- ${p.name}: ${money(p.total_gbp)} — ${p.total_gbp>check.max_total_gbp?"above":"within"} the maximum`),
  "These prices alone do not confirm suitability, availability or a booking."].join("\n");
}
export function budgetPriceChecksForText(checks:BudgetPriceCheck[]|undefined,savedText:string|undefined,text:string){
 const result=selectNativeFinancialBlocks(checks,savedText,text,budgetPriceCheckText);
 return {ok:result.ok,claim_text:result.claim_text,checks:result.selected};
}
