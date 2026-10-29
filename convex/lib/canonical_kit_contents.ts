import type { Doc } from "../_generated/dataModel";
import { recordedKit } from "./recommendation_kit";

export type KitComponent = { item_id?: string; name: string | null; units_per_listing: number;
  reviewed_supplied_parts?: Array<{name:string;qty:number}>; optional_parts?: string[] };
const key=(s:string)=>s.replace(/\((?:rx|tx)\)/gi,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const part=(s:string)=>{const m=s.match(/^\s*(\d+)\s*[x×]\s*(.+)$/i);return {name:m?.[2]??s,qty:m?Number(m[1]):null}};

/** The same owner-backed contents for bots, approval guards and the website.
 * Rich names refine a physical ID; they never change its quantity or stock pool. */
export function canonicalKitContents(components: KitComponent[], inventory: Doc<"items">[], recorded: string[] = [], recordedItemId?: string) {
  const optional=[...new Set(components.flatMap(c=>c.optional_parts??[]))];
  const optionalKeys=new Set(optional.map(key));
  const mapped=components.map(c=>{
    const item=c.item_id?inventory.find(i=>String(i._id)===c.item_id):undefined;
    return {name:item?.rental_facts?.source.trim()&&item.rental_facts.name.trim()?item.rental_facts.name:c.name,qty:c.units_per_listing};
  });
  const extras=components.flatMap(c=>(c.reviewed_supplied_parts??[]).map(p=>`${p.qty}x ${p.name}`));
  // Exact reviewed pack lists replace generic master-item compatibility notes
  // for that component; unioning both can double-count the same accessories.
  for(const c of components){
    const item=inventory.find(i=>String(i._id)===c.item_id);
    if(!(c.reviewed_supplied_parts?.length)&&item?.rental_facts?.source.trim())extras.push(...(item.compatibility?.included_with_rental??[]));
  }
  const recordedItemReviewed=recordedItemId!==undefined&&components.some(c=>String(c.item_id)===recordedItemId&&(c.reviewed_supplied_parts?.length??0)>0);
  // `recorded` comes from the primary stock item's generic compatibility field,
  // so an exact offer-level review for that same unit takes precedence.
  const recordedNotes=(recordedItemReviewed?[]:recorded).map(s=>/\bbatter(?:y|ies)\b/i.test(s)?s.replace(/\s*\d+\s*x\s*sets?\b/gi," (included)"):s);
  const notes=[...new Map([...recordedNotes,...extras].filter(s=>!optionalKeys.has(key(part(s).name))).map(s=>{const p=part(s);return [`${p.qty??""}:${key(p.name)}`,s] as const})).values()];
  return {...recordedKit(mapped,notes),optional_contents:optional};
}
