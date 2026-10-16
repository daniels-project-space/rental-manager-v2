/** Auto classification cannot make a proved, owned V-mount battery pack marketing-only. */
export function resolvedMarketingOnly(product:any,resolved:any,items:any[]) {
  if(typeof product.isMarketingOnlyOverride === "boolean")return product.isMarketingOnlyOverride;
  const powerPack=/v[ -]?mount/i.test(product.name??"") && /\d+\s*(?:wh|wah)\b/i.test(product.name??"") && !/camera|bmpcc|blackmagic|komodo|pyxis/i.test(product.name??"");
  if(powerPack && resolved.complete && resolved.owned === true && resolved.components.length && resolved.components.every((c:any)=>items.find(i=>String(i._id)===c.item_id)?.kind === "power"))return false;
  // This exact packing review verifies both TX/RX and the separately counted
  // monitor. An imported automatic tag predates that confirmation; explicit
  // operator exclusions above remain authoritative.
  const confirmedPyro=/Hollyland.*Pyro\s*S\b/i.test(product.name??"") &&
    resolved.applied_stock_rules?.some((rule:any)=>rule.source==="Daniel confirmed Pyro S paired receiver included, 16 October 2026");
  if(confirmedPyro && resolved.complete && resolved.owned===true && resolved.components.length>0)return false;
  return !!product.isMarketingOnly;
}

/** Title-only power identity needs a unique capacity-matched physical V-mount pool. */
export function powerListingPrimary(name:string,items:any[]) {
 if(!/v[ -]?mount/i.test(name) || /camera|bmpcc|blackmagic|komodo|pyxis|power station/i.test(name))return undefined;
 const capacity=name.match(/(\d+)\s*(?:wh|wah)\b/i)?.[1];if(!capacity)return undefined;
 const matches=items.filter(i=>i.kind==="power" && /v[ -]?mount/i.test(i.name_canonical) && i.name_canonical.match(/(\d+)\s*(?:wh|wah)\b/i)?.[1]===capacity);
 return matches.length===1?String(matches[0]._id):undefined;
}

/** A lexical link cannot substitute a different camera-battery family. */
export function matchesBatteryListingRole(name:string,item:{name_canonical:string;kind?:string;aliases?:string[]}) {
  if(item.kind!=="power")return true;
  const family=(text:string)=>{
    const match=text.toUpperCase().replace(/[^A-Z0-9]/g,"").match(/(FZ100|FW50)|NP?(F?970|F?750|F?570)/);
    return match ? (match[1] ?? match[2]).replace(/^F?(970|750|570)$/, "F$1") : undefined;
  };
  const requested=family(name);
  if(!requested)return true;
  return [item.name_canonical,...(item.aliases??[])].some(label=>family(label)===requested);
}
