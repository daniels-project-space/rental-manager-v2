import type {StockRequest} from "./stock_claims";
import {replacementValueComparisonsForText,type ReplacementValueComparison} from "./replacement_value_comparison";
import {budgetPriceChecksForText,type BudgetPriceCheck} from "./budget_price_check";
/** Exact informational evidence never grants stock or commercial authority. */
export function nativeInformationForText(evidence:{replacement_value_comparisons?:ReplacementValueComparison[];budget_price_checks?:BudgetPriceCheck[]}|undefined,savedText:string|undefined,text:string){
 const values=replacementValueComparisonsForText(evidence?.replacement_value_comparisons,savedText,text);
 const budgets=budgetPriceChecksForText(evidence?.budget_price_checks,savedText,values.claim_text);
 return {ok:values.ok&&budgets.ok,claim_text:values.ok&&budgets.ok?budgets.claim_text:text,comparisons:values.comparisons,budget_checks:budgets.checks};
}

/** Carry informational item identities into claim detection, never receipts.
 * Removing a price block must not erase the subject of an added stock claim. */
export function nativeInformationClaimRequest(request:StockRequest,checks:BudgetPriceCheck[]|undefined):StockRequest{
 const items=[...request.items];
 for(const check of checks??[])for(const price of check.prices)
  if(!items.some(item=>item.name===price.name))items.push({name:price.name,quantity:check.quantity});
 return {...request,items};
}
