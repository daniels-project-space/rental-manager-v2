import type { resolveBundleMapping } from "./bundle_mapping";

type Master = { _id: unknown; name_canonical: string; aliases?: string[]; kind?: string; unit_kind?: string;
  compatibility?: {included_with_rental?: string[]} };
type Declared = ReturnType<typeof resolveBundleMapping>;
const words=(s:string)=>(s.toLowerCase().replace(/ø/g,"o").replace(/reciever/g,"receiver").replace(/lavaliere?s?/g,"lavalier").match(/[a-z0-9]+/g)??[])
  .map(w=>w.length>3&&w.endsWith("s")?w.slice(0,-1):w);
function role(name:string):string|null {
  const w=words(name);const roles=new Set<string>();
  if(w.some(x=>["transmitter","tx"].includes(x)))roles.add("transmitter");
  if(w.some(x=>["receiver","rx","dongle"].includes(x)))roles.add("receiver");
  if(w.some(x=>["lavalier","lav","lapel"].includes(x)))roles.add("lavalier");
  return roles.size===1?[...roles][0]:null;
}
const suppliedWords=new Set(["transmitter","tx","receiver","rx","dongle","lavalier","lav","lapel","mic","microphone"]);

/** A reviewed counted set supplies its recorded parts. Piece declarations use
 * ceil(piece demand / pieces in a set), then max across parts of that same set.
 * No inventory pool or quantity is created, and unnamed/different equipment
 * cannot be borrowed from an unrelated kit. */
export function coverReviewedSuppliedParts(declared:Declared,items:Master[],reviewed:Map<string,number>) {
  const masters=items.filter(i=>reviewed.has(String(i._id))&&["set","kit"].includes(i.unit_kind??"")&&i.compatibility?.included_with_rental?.length);
  const components=declared.components.map(c=>({...c}));const unmatched:string[]=[];
  const bindings:Array<{masterId:string;part:string;pieceQty:number;piecesPerCountedUnit:number;requiredCountedUnits:number}>=[];
  for(const text of declared.unmatched){
    const match=text.match(/^(\d+)x (.+)$/);const qty=match?Number(match[1]):0;const name=match?.[2]??"";const partRole=role(name);
    if(!partRole||!Number.isSafeInteger(qty)||qty<1){unmatched.push(text);continue;}
    const candidates=masters.flatMap(master=>{
      const identities=[master.name_canonical,...master.aliases??[]];const allowed=new Set(identities.flatMap(words));
      for(const word of suppliedWords)allowed.add(word);
      // Keep all named model/generation tokens. Generic part names may use a
      // unique reviewed kit context; two possible kits remain ambiguous.
      if(words(name).some(w=>!allowed.has(w)))return [];
      let pieces=0;for(const line of master.compatibility!.included_with_rental!){
        const m=line.match(/^(\d+)\s*[x×]?\s+(.+)$/i);const count=m?Number(m[1]):1;const label=m?.[2]??line;
        if(role(label)===partRole&&Number.isSafeInteger(count)&&count>0)pieces+=count;
      }
      return pieces>0?[{master,pieces}]:[];
    });
    if(candidates.length!==1){unmatched.push(text);continue;}
    const {master,pieces}=candidates[0];const id=String(master._id);const required=Math.ceil(qty/pieces);
    const existing=components.find(c=>c.item_id===id);
    if(existing)existing.qty=Math.max(existing.qty,required);
    else components.push({item_id:id,name:master.name_canonical,qty:required,kind:master.kind??"unknown"});
    bindings.push({masterId:id,part:name,pieceQty:qty,piecesPerCountedUnit:pieces,requiredCountedUnits:required});
  }
  return {declared:{...declared,components,unmatched},bindings};
}
