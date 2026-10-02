import { renterItemNames } from "./renter_item_names";

const norm=(s:string)=>s.toLowerCase().replace(/’/g,"'").replace(/[^a-z0-9']+/g," ").trim();
/** Classify the subject of fulfillment assertions. Other items still require
 * independent stock/price evidence; recognising their name does not prove stock. */
export function forbiddenFulfillmentClaims(text:string, forbidden:string[], knownNames:string[]=[]) {
  if(!forbidden.length)return [];
  const identities=[...forbidden.map(name=>({name,blocked:true})),...knownNames.map(name=>({name,blocked:false}))]
    .flatMap(i=>renterItemNames(i.name).map(alias=>({...i,alias:norm(alias)}))).filter(i=>i.alias);
  const hits=new Set<string>();
  let subject={name:forbidden[0],blocked:true};
  // Keep decimal model names intact. Contrast clauses have independent subjects.
  const clauses=text.split(/(?<!\d)[.!?]|[.!?](?!\d)|[;\n]|\b(?:but|however|whereas)\b/i);
  for(const raw of clauses){
    const clause=norm(raw), padded=` ${clause} `;
    const mentions=identities.flatMap(i=>{
      const out:Array<typeof i & {at:number}>=[];
      for(let at=padded.indexOf(` ${i.alias} `);at>=0;at=padded.indexOf(` ${i.alias} `,at+1))out.push({...i,at});
      return out;
    }).sort((a,b)=>a.at-b.at || b.alias.length-a.alias.length || Number(b.blocked)-Number(a.blocked));
    for(const assertion of clause.matchAll(/\b(?:(?:feel free to|go ahead and|you can) (?:book|rent|collect|pick up)|(?:book|rent) (?:the|this|that)|(?:i|we) can (?:provide|supply|rent|offer|do|get)|available|free|in stock|approved|confirmed|all set|sorted|good to go|booked(?: for you)?|ready for you|locked in|go ahead and pay|just (?:needs?|pay)|(?:i|we)(?:'ve)? (?:have(?: got)?|got|stock|carry))\b/g)){
      const at=assertion.index!, prefix=clause.slice(0,at), after=clause.slice(at+assertion[0].length);
      if(/\b(?:not|never|no longer|isn't|aren't|wasn't|weren't|don't|doesn't|do not|cannot be|can't be)\s*$/.test(prefix)
        || assertion[0]==="free" && /\bfeel\s*$/.test(prefix))continue;
      const preceding=mentions.filter(m=>m.at<=at);
      // Equal positions select the longest exact identity, then the blocked one.
      const lastAt=preceding.at(-1)?.at;
      const named=lastAt===undefined?undefined:preceding.find(m=>m.at===lastAt);
      const following=/^(?:i|we|you|go ahead|feel free|book |rent )/.test(assertion[0]) ? mentions.find(m=>m.at>=at+assertion[0].length && m.at-at<70 &&
        clause.slice(at+assertion[0].length,m.at).trim().split(/\s+/).every(w=>!w || ["the","a","an","my","our","another","you","also","instead"].includes(w))):undefined;
      const current=following??named??subject;
      const wholeBooking=/\b(?:your|the|this|that) (?:booking|rental|request|order) (?:is|has been|will be)\s*$/.test(prefix);
      if(current.blocked || wholeBooking)hits.add(current.blocked?current.name:forbidden[0]);
    }
    if(mentions.length){const lastAt=mentions.at(-1)!.at;subject=mentions.find(m=>m.at===lastAt)!;}
  }
  return [...hits];
}
