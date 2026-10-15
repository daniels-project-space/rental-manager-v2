import { countedPieceBasis, type CountedMaster } from "./counted_piece_requirements";
import { bestMatch } from "./item_name_match";
import { isStandardAccessory } from "./reservations/itemUnits";
import { extractComponents } from "./bundle_description_parse";
import { declaredLensIdentity } from "./declared_lens_identity";

type Inventory = CountedMaster & { _id: unknown; name_canonical: string; kind?: string; qty?: number; aliases?: string[]; lens_mount?: string | null; status?: string; is_marketing_only?: boolean; track_independent_stock?: boolean };
const mountTokens = new Set(["ef", "l", "rf", "e", "pl", "mount"]);
const tokens = (text: string) => (text.toLowerCase().replace(/(\d+)\s*(?:wah|wh|watt[ -]?hours?)\b/g,"$1wh").replace(/ø/g,"o").replace(/\bg\s*-?\s*master\b/g, "gm").replace(/\bfx\s+(\d+)\b/g, "fx$1").replace(/\ba\s+7\b/g, "a7").replace(/\ba7\s*(s|r)?\s*(iii|iv|ii|v)\b/g, "a7$1$2").match(/[a-z0-9]+/g) ?? [])
  .map(token => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token);
// Whole generic supplied hardware lines do not describe independent rentals.
// Named or explicitly tracked matching pools still participate in coverage.
const bundledHardware = /^(?:(?:mounting\s+)?(?:clamps?|clips?|brackets?)|antennas?|side\s+handles?|barn\s+doors?|soft\s+diffusion(?:\s+sheets?)?|power\s+adapters?|charging\s+cases?|fluid\s+head\s+handles?|remote triggers? for off-camera control|nozzle attachments?(?: \([^)]*\))?|filled smoke chamber fillings(?: \([^)]*\))?|rod rig systems?|manual follow focus wheels?|(?:DJI\s+)?(?:adapter|quick[- ]release|mounting)\s+plates?|sandbags?|gel\s+(?:kits?|sets?|sheets?))$/i;
const incidental = /\b(?:batter(?:y|ies)|chargers?|cables?|(?:carry|carrying|charging|charge)\s+(?:bags?|cases?)|uv\s+filters?|(?:camera )?cage|(?:sd|memory) cards?|(?:cfexpress|micro[- ]?sd|sdxc|sdhc)\b[^.;]{0,50}\bcards?|ssds?|\d+\s*(?:tb|gb)\s+(?:card|media))\b/i;
const suppliedCaseObject=(name:string)=>/\b(?:carry|carrying|charging|charge)\s+(?:bags?|cases?)\b/i.test(name.split(/\b(?:with|including|includes|and|plus)\b|[,;+&]/i)[0]);

export type BundleMappingContext = {
  inventory: Inventory[];
  matches: Map<string, { item: Inventory | null; ambiguous: boolean }>;
  tokens: Map<string, string[]>;
  rankedTokens: Map<string, Set<string>>;
  lenses: Map<string, { ranges: number[][]; words: Set<string> }>;
};
/** One immutable query snapshot. Do not reuse across inventory reads. */
export function createBundleMappingContext(inventory: Inventory[]): BundleMappingContext {
  return { inventory, matches: new Map(), tokens: new Map(), rankedTokens: new Map(), lenses: new Map() };
}
/** Shared by declared components and legacy primary-item fallback. */
export function matchesGimbalComponentRole(name: string, item: Pick<Inventory, "name_canonical">) {
  const requestedObject = name.split(/\b(?:with|including|includes)\b/i)[0];
  if (!/\b(?:gimbal|ronin|rs\s*[234](?:\s*pro)?|rsc\s*2|bg\s*30)\b/i.test(requestedObject)) return true;
  const chargerRequest = /\bchargers?\b/i.test(requestedObject);
  const batteryRequest = /\bbg\s*30\b/i.test(requestedObject) || /\bbatter(?:y|ies)\b/i.test(requestedObject) && !/\bbattery[- ]powered\b/i.test(requestedObject);
  const charger = /\bchargers?\b/i.test(item.name_canonical);
  const battery = /\bbatter(?:y|ies)\b/i.test(item.name_canonical) && !charger;
  return chargerRequest ? charger : batteryRequest ? battery : !battery && !charger;
}
function componentIdentity(name:string,items:Inventory[],genericHardware:boolean,incidentalComponent:boolean,context?:BundleMappingContext) {
  const cachedTokens = (text: string) => {
    let result = context?.tokens.get(text);
    if (!result) { result = tokens(text); context?.tokens.set(text, result); }
    return result;
  };
  // An integrated tripod head is part of that tripod, not an extra standalone head.
  const modelName = name.replace(/\s*\((?:featuring|capable of|same sensor as)\b[^)]*\)/gi, "");
  const identityName = /\btripod\b.*\bwith\s+(?:an?\s+)?(?:integrated\s+)?fluid\s+head\b/i.test(modelName)
    ? modelName.split(/\bwith\b/i)[0].replace(/\bheavy[- ]duty\b/ig,"") : modelName;
  const lineTokens = new Set(tokens(identityName));
  const explicitMount = name.match(/\bCanon\s+(EF|RF)\b|\b(EF|RF|PL|E|L)[ -]?mount\b/i);
  const mount = (explicitMount?.[1] ?? explicitMount?.[2])?.toLowerCase();
  // A model name shared by a gimbal and its battery is not a stock identity.
  // Inspect the requested object, before supplied accessories ("with battery").
  // Apply this before both alias matching and the fuzzy fallback.
  const candidates = items.filter(item => {
    // A supplied card reader cannot consume a second memory card merely
    // because its name contains the card's full model label.
    if (["storage_card","media"].includes(item.kind??"") && /\breaders?\b/i.test(identityName)) return false;
    if (!matchesGimbalComponentRole(identityName, item)) return false;
    if (item.kind === "smoke_fx" && /\bbattery grip\b|\bspare batter(?:y|ies)\b|\bnozzle\b|\bremote trigger\b/i.test(identityName) && !/\bbattery grip\b|\bnozzle\b|\bremote trigger\b/i.test(item.name_canonical)) return false;
    // A named device's supplied case is not another copy of that device.
    // A registered case may still match its own explicit inventory identity.
    const caseRequest=suppliedCaseObject(identityName);
    if(caseRequest && !/\b(?:bag|case)\b/i.test(item.name_canonical))return false;
    const recordedMount = item.lens_mount?.toLowerCase().match(/\b(ef|rf|pl|e|l)\b/)?.[1]
    ?? item.name_canonical.toLowerCase().match(/\b(ef|rf|pl)\b/)?.[1];
    return !mount || !recordedMount || mount === recordedMount;
  });
  const lensIdentity = declaredLensIdentity(name, candidates,context?.lenses);
  let picked: Inventory | null = null;
  let specificity = 0;
  let ambiguous = false;
  for (const item of lensIdentity.explicit ? [] : candidates) {
    if (isStandardAccessory(item.kind, item.name_canonical) && item.track_independent_stock !== true) continue;
    const aliases = [item.name_canonical, ...(item.aliases ?? [])];
    // A missing aperture or set size may be omitted from a contents line.
    // Keep explicit values and require a unique manufacturer/model identity.
    if (item.kind === "lens" && !/\b[ft]\s*\/?\d/i.test(name))
    aliases.push(item.name_canonical.replace(/\b[ft]\s*\/?\d+(?:\.\d+)?\b/gi, ""));
    if (!/\b\d+[ -]+lens\b/i.test(name))
    aliases.push(item.name_canonical.replace(/\b\d+[ -]+lens\b/gi, "lens"));
    for (const alias of aliases) {
    const all = cachedTokens(alias);
    const stripped = all.filter(token => !mountTokens.has(token));
    const required = stripped.length >= 2 ? stripped : all;
    const exactTrackedHardware = genericHardware && item.track_independent_stock === true &&
      all.join(" ") === tokens(name).join(" ");
    if (genericHardware && !exactTrackedHardware) continue;
    if ((!exactTrackedHardware && required.length < 2) || !required.every(token => lineTokens.has(token))) continue;
    if (required.length > specificity) { picked = item; specificity = required.length; ambiguous = false; }
    else if (required.length === specificity && picked?._id !== item._id) ambiguous = true;
    }
  }
  // An incidental line needs the full canonical/alias identity, not a fuzzy
  // guess from "batteries" or "card" to an unrelated stock pool.
  const match = lensIdentity.explicit ? lensIdentity.item : !ambiguous && picked ? picked : incidentalComponent ? null : bestMatch(name, candidates, item => item.name_canonical, item => item.aliases ?? [],context?.rankedTokens);
  const item = ambiguous || !match ? null : "name_canonical" in match ? match : match.match && match.confident ? match.match : null;
  return {item,ambiguous};
}

/** Contents identity and stated quantities, independently of whether we own them. */
export function resolveBundleMapping(description: string, items: Inventory[], context?: BundleMappingContext) {
  if(context && context.inventory!==items)throw Error("Bundle context belongs to a different inventory snapshot");
  const { components, usedBullets, hasContentsSection } = extractComponents(description);
  const resolved: Array<{item_id:string;name:string;qty:number;kind:string}> = [];
  const unmatched: string[] = [];
  const counted = new Map<string,{whole:number;parts:Map<string,{qty:number;pieces:number}>}>();
  for (const component of components) {
    // A second leading count is malformed/ambiguous contents, not a model
    // token to discard while adopting the outer quantity (e.g. 1x 3x cameras).
    if (/^\d{1,2}\s*x\s+/i.test(component.name)) {
      unmatched.push(`Ambiguous quantity: ${component.qty}x ${component.name}`); continue;
    }
    // A model choice is not a resolved stock identity, even if one offered
    // alternative is owned. Whole kits and individual units use the same gate.
    if (/\(\s*or\b/i.test(component.name)) {
      unmatched.push(`${component.qty}x ${component.name}`); continue;
    }
    // Generic bundled accessories must not become battery-pack rentals.
    // Named independently tracked pools still participate in kit coverage.
    const majorEquipment = /\b(?:camera(?!\s+(?:batter|cage))|bmpcc|blackmagic|fx\d|a7\w*|gimbal|lens(?:es)?|tripod|mic(?:rophone)?|rig|monitor|lights?|led)\b/i;
    const genericHardware = bundledHardware.test(component.name);
    const caseParts=component.name.split(/\b(?:with|including|includes|and|plus)\b|[,;+&]/i);
    const suppliedCase=suppliedCaseObject(component.name);
    if(suppliedCase && caseParts.length>1 && majorEquipment.test(caseParts.slice(1).join(" "))){
      unmatched.push(`${component.qty}x ${component.name}`);continue;
    }
    const incidentalComponent = genericHardware || suppliedCase || incidental.test(component.name) && !majorEquipment.test(component.name);
    const name = component.name.replace(/\bdzo(?:film)?\b/gi, "DZOFilm");
    const key=name.toLowerCase();
    let identity=context?.matches.get(key);
    if(!identity){identity=componentIdentity(name,items,genericHardware,incidentalComponent,context);context?.matches.set(key,identity);}
    const {item,ambiguous}=identity;
    if (!item && incidentalComponent && !ambiguous) continue;
    if (!item || !Number.isInteger(component.qty) || component.qty < 1) { unmatched.push(`${component.qty}x ${component.name}`); continue; }
    if (isStandardAccessory(item.kind, item.name_canonical) && item.track_independent_stock !== true) continue;
    const id=String(item._id),basis=countedPieceBasis(name,item);
    if(basis==="invalid"){unmatched.push(`${component.qty}x ${component.name}`);continue;}
    let demand=counted.get(id);
    if(!demand){demand={whole:0,parts:new Map()};counted.set(id,demand);}
    if(basis){const part=demand.parts.get(basis.key);if(part)part.qty+=component.qty;else demand.parts.set(basis.key,{qty:component.qty,pieces:basis.pieces});}
    else demand.whole+=component.qty;
    const qty=demand.whole+Math.max(0,...[...demand.parts.values()].map(p=>Math.ceil(p.qty/p.pieces)));
    const existing=resolved.find(row=>row.item_id===id);
    if(existing)existing.qty=qty;
    else resolved.push({item_id:id,name:item.name_canonical,qty,kind:item.kind??"unknown"});
  }
  return { components: resolved, unmatched, structured: usedBullets, explicit: hasContentsSection };
}

/** An incomplete override cannot hide a known non-rentable advertised component.
 * Declarations identify blockers; they never add stock to the physical mapping. */
export function declaredRentalBlockers(declared: ReturnType<typeof resolveBundleMapping> | null, items: Inventory[]) {
  if (!declared?.explicit) return [];
  return declared.components.flatMap(component => {
    const item = items.find(i => String(i._id) === component.item_id);
    const reason = item?.is_marketing_only ? "marketing_only" : item?.status !== undefined && item.status !== "active" ? "inactive"
      : item?.qty !== undefined && item.qty <= 0 ? "zero_quantity" : null;
    return reason ? [{ item_id: component.item_id, name: component.name, kind: component.kind, reason }] : [];
  });
}
