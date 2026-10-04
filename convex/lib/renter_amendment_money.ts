export type AmendmentMoneyRole="base"|"total"|"increase"|"reduction"|"daily"|"unlabelled"|"unsupported";
/** Currency claims are bounded by the adjacent amounts. An amount's suffix
 * cannot label the following amount; explicit total/daily labels take priority. */
export function amendmentMoneyClaims(text:string){
 const unsupported=/[$€¥]\s*[-+]?\d|\b(?:USD|EUR|AUD|CAD|JPY|CNY)\s*[-+]?\d|\d\s*(?:USD|EUR|AUD|CAD|JPY|CNY)\b/i.test(text);
 const pattern=/(?:£\s*|\bGBP\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\d|[.,]\d)|(?<![\d.,])(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?!\d|[.,]\d)\s*(?:GBP|pounds)\b/gi;
 const matches=[...text.matchAll(pattern)];
 const markers=[...text.matchAll(/£|\bGBP\s*[-+]?\d|\d[\d.,]*\s*(?:GBP|pounds)\b/gi)];
 if(unsupported || matches.length!==markers.length)return [{amount:0,index:0,length:0,before:"",after:"",role:"unsupported" as AmendmentMoneyRole}];
 return matches.map((m,i)=>{
  const index=m.index!,length=m[0].length;
  const before=text.slice(i?matches[i-1].index!+matches[i-1][0].length:0,index).split(/[;\n]|(?<=[.!?])\s+/).at(-1)!.slice(-100);
  const after=text.slice(index+length,matches[i+1]?.index??text.length).split(/[;\n]|(?<=[.!?])\s+/)[0].slice(0,80);
  const suffix=/^\s*(?:in\s+)?(total|extra|additional|more|less|off|reduction|per day|a day|daily)\b/i.exec(after)?.[1].toLowerCase();
  let role:AmendmentMoneyRole="unlabelled";
  if(/^\s*\/\s*day\b/i.test(after)||["per day","a day","daily"].includes(suffix??"")||/\bdaily\s+(?:rate|price)\s*(?:is|of|at|:)?\s*$/i.test(before))role="daily";
  else if(suffix==="total")role="total";
  else if(/\b(?:current|original|existing|old|base)\s+(?:booking|order|rental|hire)\s*(?:is|of|at|:)?\s*$/i.test(before) || /\b(?:current|original|existing|old|base)\s+(?:(?:booking|order|rental|hire)\s+)?(?:total|price|cost|amount)\s*(?:is|of|at|:)?\s*$/i.test(before)
    ||/\b(?:total|price|cost|amount)\b[^£.!?]*\bfrom\s*$/i.test(before))role="base";
  else if(/\b(?:total|booking|basket|order)\s*(?:is|of|to|at|comes to|would be|will be|would come to|will come to|:)?\s*$/i.test(before))role="total";
  else if(["extra","additional","more"].includes(suffix??"")||/\b(?:extra|additional|more|addition|additions)\s*(?:cost|amount)?\s*(?:is|of|to|at|comes to|would be|will be|would come to|will come to|:)?\s*$/i.test(before))role="increase";
  else if(["less","off","reduction"].includes(suffix??"")||/\b(?:less|reduction|saving|discount)\s*(?:of|by|is|at|:)?\s*$/i.test(before))role="reduction";
  if(/\b(?:deposit|refund|discount|courier|delivery|replacement|insured|security hold)\b/i.test(before)||/^\s*(?:deposit|refund|discount|courier|delivery|replacement|insured|security hold)\b/i.test(after))role="unsupported";
  return {amount:Number((m[1]??m[2]).replace(/,/g,"")),index,length,before,after,role};
 });
}
