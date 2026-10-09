import {tokenize} from "./item_name_match";
export type CountedMaster={unit_kind?:string;name_canonical:string;aliases?:string[];status?:string;is_marketing_only?:boolean;qty?:number;compatibility?:{included_with_rental?:string[]}|null};
const words=(s:string)=>tokenize(s.replace(/\breciever\b/gi,"receiver").replace(/\blaveliers?\b/gi,"lavalier"));
/** Identity is already resolved. Recorded kit contents determine its counting
 * basis; neither a primary ID nor a generic role may select an inventory pool. */
export function countedPieceBasis(name:string,item:CountedMaster):{key:string;pieces:number}|null|"invalid" {
  if(!["set","kit"].includes(item.unit_kind??"")||item.status!=="active"||item.is_marketing_only!==false||!Number.isSafeInteger(item.qty)||(item.qty??0)<=0)return null;
  if(/\(\s*or\b/i.test(name))return "invalid";
  if(/\b(?:sets?|kits?|pairs?|packs?)\b/i.test(name))return null;
  const query=words(name),parent=new Set([item.name_canonical,...(item.aliases??[])].flatMap(s=>[...words(s)]));
  const candidates=(item.compatibility?.included_with_rental??[]).flatMap(line=>{
    const m=line.match(/^(\d+(?:\.\d+)?)\s*[x×]\s+(.+)$/i);if(!m)return [];
    const part=words(m[2]);
    // LED is a descriptor on the recorded lighting part, not a model suffix.
    if(item.unit_kind==="set"&&parent.has("light"))part.delete("led");
    const allowed=new Set([...parent,...part]);
    if(!part.size||![...part].every(w=>query.has(w))||![...query].every(w=>allowed.has(w)))return [];
    return [{key:[...part].sort().join(" "),pieces:Number(m[1])}];
  });
  if(!candidates.length)return null;
  if(candidates.length!==1||!Number.isSafeInteger(candidates[0].pieces)||candidates[0].pieces<1)return "invalid";
  return candidates[0];
}
