type Item = { _id: unknown; name_canonical: string; kind?: string; compatibility?: { included_with_rental?: string[] } };
type Mapping = { components: Array<{ item_id: unknown; qty: number }> };

function mediaIdentity(text:string){
 const kind=/\b(?:ssds?|solid.state)\b/i.test(text)?"ssd":/\b(?:cards?|sd(?:hc|xc)?|micro\s*sd|cfast|cf\s*express)\b/i.test(text)?"card":null;
 if(!kind)return null;
 const capacity=/\b(\d+(?:\.\d+)?)\s*(GB|TB)\b/i.exec(text),format=/\bcf\s*express(?:\s+(?:type\s+)?([ab]))?\b|\b(cfast|micro\s*sd|sd(?:hc|xc)?)\b/i.exec(text);
 return {kind,gb:capacity?Number(capacity[1])*(capacity[2].toLowerCase()==="tb"?1000:1):null,
  format:format?format[2]?.toLowerCase().replace(/\s/g,"")??`cfexpress${format[1]?.toLowerCase()??""}`:null};
}
const compatibleFormat=(a:string|null,b:string|null)=>!a||!b||a===b||a==="cfexpress"&&b.startsWith(a)||b==="cfexpress"&&a.startsWith(b);
/** A generic mapped card and a typed accessory note may refer to one unit.
 * Preserve the note for review; never render it as a second supplied item or
 * use slot compatibility to fill missing type/capacity attributes. */
function reconcileMedia(components:Array<{name:string|null;qty:number}>,accessories:string[]){
 const media=components.flatMap(c=>{const identity=c.name&&mediaIdentity(c.name);return identity&&Number.isInteger(c.qty)&&c.qty>0?[{...identity,qty:c.qty}]:[];});
 const unresolved:string[]=[],retained:string[]=[];
 for(const text of accessories){
  const r=mediaIdentity(text),count=/^\s*(\d+)\s*[x×]\s*/i.exec(text);
  const possible=r?media.filter(p=>p.kind===r.kind&&(p.gb===null||r.gb===null||p.gb===r.gb)&&compatibleFormat(p.format,r.format)):[];
  if(!r||!possible.length){retained.push(text);continue;}
  const subset=possible.length===1&&(r.gb===null||r.gb===possible[0].gb)&&
   (r.format===null||r.format===possible[0].format||r.format==="cfexpress"&&possible[0].format?.startsWith(r.format))&&
   (!count||Number(count[1])===possible[0].qty);
  if(!subset)unresolved.push(text);
 }
 return {retained,unresolved};
}

/** Known contents per listing. A stock mapping is not an exhaustive kit.
 * Accessory descriptions may overlap components or describe sets: do not add
 * them into individual-unit totals. */
export function recordedKit(components: Array<{ name: string | null; qty: number }>, accessories: string[]) {
  const mapped = components.filter(c => c.name && Number.isInteger(c.qty) && c.qty > 0)
    .map(c => `${c.qty} × ${c.name}`);
  const physicalName = (name: string) => name.toLowerCase().replace(/batteries/g,"battery").replace(/cards/g,"card").replace(/cases/g,"case").replace(/chargers/g,"charger").replace(/[^a-z0-9]/g,"");
  const reconciled=reconcileMedia(components,accessories);
  const recorded = reconciled.retained.filter(c => typeof c === "string" && c.trim()).map(c => c.trim()).filter(text=>{
    const explicit=/^(\d+)\s*[×x]\s*(.+)$/i.exec(text);
    // Only a matching physical name AND quantity can collapse. A pack, set,
    // unspecified count or different quantity remains distinct evidence.
    return !explicit || !components.some(c=>c.name && c.qty===Number(explicit[1]) && physicalName(c.name)===physicalName(explicit[2]));
  });
  const contents = [...new Set([...mapped, ...recorded])];
  return { contents, unreconciled_contents:reconciled.unresolved, included: contents.length ? contents.join(", ") : null,
    completeness: contents.length ? "partial" as const : "unknown" as const,
    source: mapped.length ? "physical_mapping_and_inventory" : recorded.length ? "inventory_record" : "unknown" };
}

/** Advertising title/description never proves inclusions. Use the same body
 * records and physical mapping as selected-listing context. */
export function recommendationKit(item: Item, mapping: Mapping | undefined, inventory: Item[]) {
  const components = mapping?.components.map(c => ({ item: inventory.find(i => String(i._id) === String(c.item_id)), qty: c.qty }));
  const complete = !!components?.length && components.every(c => !!c.item && Number.isInteger(c.qty) && c.qty > 0);
  const recorded = item.compatibility?.included_with_rental ?? [];
  const kit = recordedKit(complete ? components!.map(c => ({ qty: c.qty, name: c.item!.name_canonical })) : [], recorded);
  const contents = kit.contents;
  return { contents, unreconciled_contents:kit.unreconciled_contents, included: contents.length ? contents.join(", ") : null,
    includes_lens: item.kind === "camera" && complete ? components!.some(c => c.item?.kind === "lens") : null,
    kit_completeness: kit.completeness, mapping_complete: complete, source: complete ? "physical_mapping_and_inventory" : recorded.length ? "inventory_record" : "unknown" };
}
