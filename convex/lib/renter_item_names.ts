import { shortItemName } from "./item_display_name";

/** Presentation aliases of an established item identity. Expand only complete
 * known model names; advertising titles and comparison models stay literal. */
export function renterItemNames(name: string): string[] {
  const names = [name, shortItemName(name)];
  const bm = /^(?:BMPCC|Blackmagic(?:\s+Pocket\s+Cinema\s+Camera|\s+Cinema\s+Camera)?)\s+6K\s+(Pro|Full\s+Frame|FF)$/i.exec(name.trim());
  if (bm) {
    const variant = /^pro$/i.test(bm[1]) ? "Pro" : "Full Frame";
    names.push(`6K ${variant}`);
    for (const prefix of ["BMPCC", "Blackmagic", "Blackmagic Pocket Cinema Camera", "Blackmagic Cinema Camera"])
      names.push(`${prefix} 6K ${variant}`);
    if (variant === "Full Frame") names.push("BMPCC 6K FF", "Blackmagic 6K FF", "6K FF");
  }
  const remus=/^(?:Anamorphic\s+)?Blazar\s+Remus\s+(\d+)\s*mm(?:\s+.*)?$/i.exec(name.trim());
  if(remus)names.push(`Blazar Remus ${remus[1]}mm`);
  return [...new Set(names.filter(Boolean))];
}

/** Native reviewed lens identity, never generated inventory aliases or tool
 * arguments. A shared-variant record may name its family, not a generation. */
export function reviewedLensNames(item: {name:string;kind?:unknown;spec_verification?:unknown;lens_capabilities?:unknown}) {
  const names=item.kind==="lens" ? renterItemNames(item.name) : [item.name];
  const spec=item.spec_verification as {model?:unknown;source_url?:unknown}|null;
  const cap=item.lens_capabilities as {model?:unknown;source_url?:unknown;model_scope?:unknown;reviewed_models?:Array<{model?:unknown;source_urls?:unknown}>}|null;
  if(item.kind!=="lens" || !spec || !cap || typeof spec.model!=="string" || !spec.source_url ||
    cap.model!==spec.model || cap.source_url!==spec.source_url)return names;
  if(cap.model_scope==="shared_variants") {
    if(!Array.isArray(cap.reviewed_models) || cap.reviewed_models.length<2 ||
      !cap.reviewed_models.every(m=>typeof m.model==="string" && Array.isArray(m.source_urls) && m.source_urls.length))return names;
    const family=spec.model.split(/\s+\/\s+/)[0].trim();
    if(family && family!==spec.model)names.push(family);
  } else names.push(spec.model);
  return [...new Set(names)];
}
