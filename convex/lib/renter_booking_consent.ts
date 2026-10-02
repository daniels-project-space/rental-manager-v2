/** Explicit renter restrictions, read from the server's current message.
 * This is a deny gate, not a substitute for action/target reconciliation. */
export function renterRequestsReadOnly(text: string, action: "add_item" | "remove_item" | "set_dates") {
  const message=text.replace(/[’‘]/g,"'").replace(/\s+/g," ").trim();
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
