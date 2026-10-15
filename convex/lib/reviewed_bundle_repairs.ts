import { resolveBundleMapping } from "./bundle_mapping";
import type { Doc } from "../_generated/dataModel";

/** Repair legacy generated prose only when an existing reviewed allocation
 * independently establishes the same identity AND quantity. No new stock,
 * unreviewed nested count or different lens model is inferred. */
export function repairReviewedBundle(declared: ReturnType<typeof resolveBundleMapping>, inventory: Doc<"items">[], allocation?: Array<{item_id:string;qty:number}>) {
  if (!declared.explicit || !declared.structured || !allocation?.length) return declared;
  const components=declared.components.map(c=>({...c}));
  const unmatched=declared.unmatched.filter(line=>{
    let repaired: ReturnType<typeof resolveBundleMapping> | null=null;
    const nested=line.match(/^Ambiguous quantity: 1x (\d{1,2})x (.+)$/i);
    if(nested)repaired=resolveBundleMapping(`Contents: • ${nested[1]}x ${nested[2]}`,inventory);
    const genericLens=line.match(/^(\d{1,2})x (\d+(?:\.\d+)?-\d+(?:\.\d+)?mm) Cinema Camera Set$/i);
    if(genericLens){
      const reviewedLenses=inventory.filter(item=>item.kind==="lens"&&allocation.some(c=>c.item_id===String(item._id)));
      repaired=resolveBundleMapping(`Contents: • ${genericLens[1]}x ${genericLens[2]} zoom lens`,reviewedLenses);
    }
    if(nested && repaired && !repaired.components.length && !repaired.unmatched.length)return false;
    if(!repaired?.components.length || repaired.unmatched.length || repaired.components.some(c=>!allocation.some(a=>a.item_id===c.item_id&&a.qty===c.qty)))return true;
    for(const c of repaired.components){const old=components.find(x=>x.item_id===c.item_id);if(old)old.qty=Math.max(old.qty,c.qty);else components.push(c);}
    return false;
  });
  return {...declared,components,unmatched};
}
