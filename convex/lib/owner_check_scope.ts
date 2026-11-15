import { samePriceNames, type PriceEvidence } from "./price_claims";
/** Keep unrelated owner work on the task list without labelling a price-only
 * answer as waiting on different cameras the model happened to explore. */
export function unrelatedToRenderedReplacement(input:{kind:string;candidateNames:string[];flags:Array<{type:string}>;prices:PriceEvidence[]}):boolean {
 if(input.kind!=="camera_recommendation" || !input.flags.some(f=>f.type==="NATIVE_REPLACEMENT_QUOTE_RENDERED") || !input.candidateNames.length)return false;
 const proposals=input.prices.filter(p=>p.kind==="basket" && p.source==="native_lab_proposal" && p.proposal?.removed_items?.length);
 const targets=[...new Set(proposals.flatMap(p=>p.proposal!.added_items.map(i=>i.name)))];
 return targets.length===1 && input.candidateNames.every(name=>!samePriceNames([name],targets));
}
