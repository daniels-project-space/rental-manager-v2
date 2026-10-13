/** Auto classification cannot make a proved, owned V-mount battery pack marketing-only. */
export function resolvedMarketingOnly(product:any,resolved:any,items:any[]) {
  if(typeof product.isMarketingOnlyOverride === "boolean")return product.isMarketingOnlyOverride;
  const powerPack=/v[ -]?mount/i.test(product.name??"") && /\d+\s*(?:wh|wah)\b/i.test(product.name??"") && !/camera|bmpcc|blackmagic|komodo|pyxis/i.test(product.name??"");
  if(powerPack && resolved.complete && resolved.owned === true && resolved.components.length && resolved.components.every((c:any)=>items.find(i=>String(i._id)===c.item_id)?.kind === "power"))return false;
  return !!product.isMarketingOnly;
}

/** Title-only power identity needs a unique capacity-matched physical V-mount pool. */
export function powerListingPrimary(name:string,items:any[]) {
 if(!/v[ -]?mount/i.test(name) || /camera|bmpcc|blackmagic|komodo|pyxis|power station/i.test(name))return undefined;
 const capacity=name.match(/(\d+)\s*(?:wh|wah)\b/i)?.[1];if(!capacity)return undefined;
 const matches=items.filter(i=>i.kind==="power" && /v[ -]?mount/i.test(i.name_canonical) && i.name_canonical.match(/(\d+)\s*(?:wh|wah)\b/i)?.[1]===capacity);
 return matches.length===1?String(matches[0]._id):undefined;
}
