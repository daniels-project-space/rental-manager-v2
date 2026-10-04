import { bestMatch } from "./item_name_match";

/** Explicit renter restrictions, read from the server's current message.
 * This is a deny gate, not a substitute for action/target reconciliation. */
export function renterRequestsReadOnly(text: string, action: "add_item" | "remove_item" | "set_dates") {
  const message=text.replace(/[’‘]/g,"'").replace(/\s+/g," ").trim()
    // "Do not add gear or change my basket" scopes the same prohibition over
    // both verbs. Expand that coordination before the shared action checks.
    .replace(/\b(do not|don't|dont|never)\s+([^.!?;]+?)\s+(?:or|nor)\s+(?=(?:change|edit|modify|amend|update|touch|add|include|book|reserve|remove|drop|move|extend)\b)/gi,"$1 $2 or $1 ");
  if (/\b(?:(?:quote|quotation|estimate|pricing)\s+only|only\s+(?:an?\s+)?(?:quote|quotation|estimate)|just\s+(?:an?\s+)?(?:quote|quotation|estimate)|(?:quote|price)\s+(?:it|this|that|the gear)\s+(?:for now|first))\b/i.test(message)) return true;
  const no=/\b(?:do not|don't|dont|please don't|never)\s+(?:(?:actually|yet|just)\s+)?(?:change|edit|modify|amend|update|touch)\s+(?:(?:my|the|this|our|any|your)\s+)?(?:booking|order|basket|rental|anything|items?|gear)\b/i;
  if(/\b(?:(?:do not|don't|dont)\s+make\s+(?:any\s+)?changes|without\s+making\s+(?:any\s+)?changes|leave\s+(?:my|the|our)\s+(?:booking|order)\s+unchanged)\b/i.test(message))return true;
  if(no.test(message) || /\b(?:no|without)\s+(?:booking\s+|order\s+)?(?:changes|edits|modifications)\b/i.test(message))return true;
  const verb=action==="add_item"?"(?:add|include|book|reserve)":action==="remove_item"?"(?:remove|drop)":"(?:move|extend|change|amend|update)";
  const object=action==="set_dates"?"(?:the |my |our )?(?:dates?|pickup|return|rental period)":"(?:anything|any (?:items?|gear|equipment)|it|them|those)";
  if(new RegExp(`\\b(?:do not|don't|dont)\\s+${verb}\\s+${object}\\b`,"i").test(message))return true;
  // A price question is not an edit request. A separate explicit instruction
  // can authorise an edit unless the message also carries a restriction above.
  const priceQuestion=/\b(?:how much|what (?:would|will) it cost|what(?:'s| is) the price|(?:can|could) you (?:quote|price)|before (?:I|we) decide)\b/i.test(message);
  const instruction=/\b(?:please\s+(?:add|remove|drop|move|extend|change|update)|go ahead(?:\s+and)?\s+(?:add|remove|drop|move|extend|change|update)|(?:can|could) you\s+(?:add|remove|drop|move|extend|change|update))\b/i.test(message);
  return priceQuestion && !instruction;
}

export type ConsentInventoryItem = {id:string;name:string;aliases?:string[];kind?:string};

/** Reconcile named negative instructions against Native identities, not tool arguments. */
export function renterProhibitsItemChange(text:string,action:"add_item"|"remove_item",inventory:ConsentInventoryItem[],selectedIds:string[]) {
  const selected=new Set(selectedIds);
  const clauses=text.replace(/[’‘]/g,"'").split(/(?<=[.!?])\s+|[;\n]|\b(?:but|instead)\b/i);
  const verb=action==="add_item"?"(?:add|include|book|reserve)":"(?:remove|drop)";
  const negative=new RegExp(`\\b(?:do not|don't|dont|never|not to|no need to)\\s+(?:want\\s+(?:(?:you|us)\\s+)?to\\s+)?(?:(?:actually|yet|just|also)\\s+)?${verb}\\b\\s*(.*)`,"i");
  const categories: Array<[RegExp,(item:ConsentInventoryItem)=>boolean]>=[
    [/^(?:mount\s+)?adapters?$/,i=>/\b(?:adapter|converter)\b|\b(?:pl|ef)\s*(?:to|→|-)\s*\w+/i.test(i.name)],
    [/^(?:camera\s+)?bod(?:y|ies)$|^cameras?$/,i=>["camera","camera_body"].includes(i.kind??"")],
    [/^lens(?:es)?$/,i=>i.kind==="lens"],
    [/^batter(?:y|ies)$/,i=>i.kind==="battery"||/\bbatter(?:y|ies)\b/i.test(i.name)],
  ];
  const passive=action==="add_item" ? /\b(?:do not|don't|dont)\s+(?:want|need)\s+(.+?)\s+(?:added|included|booked|reserved)\b/i : /\b(?:do not|don't|dont)\s+(?:want|need)\s+(.+?)\s+(?:removed|dropped)\b/i;
  const directive=action==="add_item" ? /\b(?:leave\s+out|exclude|omit|hold\s+off\s+(?:on\s+)?adding)\s+(.*)/i : /\b(?:keep|leave)\s+(.+?)\s+(?:(?:on|in)\s+(?:the|my|our)\s+(?:booking|order|basket)|alone)\b/i;
  for(const clause of clauses){
    const match=negative.exec(clause) ?? passive.exec(clause) ?? directive.exec(clause);if(!match)continue;
    const object=match[1].split(/[—–]|\b(?:because|since)\b|,\s*(?:please|can|could|go ahead|add|include|book|reserve|remove|drop)\b|\b(?:please|go ahead)\s+(?:add|include|book|reserve|remove|drop)\b/i)[0];
    for(const raw of object.split(/\b(?:and|or|plus)\b|,/i)){
      const target=raw.trim().replace(/^(?:(?:the|your|our|my|any|more|extra|additional|another|a|an|one|two|three|four|\d+)\s+)*/i,"").replace(/[.!?]+$/,"").trim();
      if(!target || /^(?:it|them|those|anything|everything|items?|gear|equipment)$/i.test(target))return true;
      const category=categories.find(([pattern])=>pattern.test(target));
      if(category){if(inventory.some(item=>selected.has(item.id)&&category[1](item)))return true;continue;}
      const resolved=bestMatch(target,inventory,item=>item.name,item=>item.aliases??[]);
      // An unresolved restriction requires clarification, never an ignored edit.
      if(!resolved.confident || !resolved.match)return true;
      if(selected.has(resolved.match.id))return true;
    }
  }
  return false;
}
