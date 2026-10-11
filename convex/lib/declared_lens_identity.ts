import { tokenize } from "./item_name_match";

type Lens = { _id: unknown; name_canonical: string; aliases?: string[]; kind?: string; lens_mount?: string | null };
const labels = tokenize("lens lenses zoom telephoto full frame mount");
const normalize = (text:string) => text.replace(/\bg\s*-?\s*master\b/gi,"GM").replace(/\bL[ -]series\b/gi,"")
  .replace(/\bSony\s+FE\b/gi,"Sony E");
function focalLengths(text: string) {
  const matches = [...withoutApertureSpecification(text).replace(/[–—−]/g, "-").matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:mm)?\b|(?<![\w.])(\d+(?:\.\d+)?)\s*mm\b/gi)];
  return matches.map(m => m[3] ? [Number(m[3]), Number(m[3])] : [Number(m[1]), Number(m[2])]);
}

const APERTURE_SPEC_RE = /\b[ft]\s*\/?\s*\d+(?:\.\d+)?(?:\s*[-–—−]\s*\d+(?:\.\d+)?)?/i;
const APERTURE_SPEC_GLOBAL_RE = /\b[ft]\s*\/?\s*\d+(?:\.\d+)?(?:\s*[-–—−]\s*\d+(?:\.\d+)?)?/gi;
function hasApertureSpecification(text:string) { return APERTURE_SPEC_RE.test(text); }
function withoutApertureSpecification(text:string) { return text.replace(APERTURE_SPEC_GLOBAL_RE, " "); }

/** A supplied lens label may omit "GM" or state an aperture absent from a legacy
 * stock row. Require the exact focal range and all other stated model tokens,
 * then a unique master identity; never rank or guess generation or lens type. */
export function declaredLensIdentity<T extends Lens>(name: string, items: T[], cache?:Map<string,{ranges:number[][];words:Set<string>;coreWords?:Set<string>}>) {
  if (!/\blens(?:es)?\b|\bzoom\b|\b[ft]\s*\/?\d/i.test(name)) return { explicit:false, item:null as T | null };
  const focal = focalLengths(name);
  if (!focal.length) return { explicit: false, item: null as T | null };
  if (focal.length !== 1) return { explicit: true, item: null as T | null };
  // Mount compatibility is checked separately by resolveBundleMapping. Keep
  // the mount token here when it is recorded, but tolerate absent legacy mount
  // metadata as that reader did; never override an explicitly different mount.
  const mount=normalize(name).match(/\b(ef|rf|pl|e|l)[ -]mount\b/i)?.[1]?.toLowerCase()
    ?? (/\bSony\s+FE\b/i.test(name)?"e":undefined);
  const query = [...tokenize(normalize(name))].filter(t => !labels.has(t) && t!==mount);
  const queryCore = [...tokenize(normalize(withoutApertureSpecification(name)))].filter(t => !labels.has(t) && t!==mount);
  const surfaces = (item:T) => [item.name_canonical, ...(item.aliases ?? [])];
  const preparedSurface = (item:T, alias:string) => {
    const key=JSON.stringify([alias,item.lens_mount]);
    let prepared=cache?.get(key);
    if(!prepared){
      const mounted=normalize(alias) + " " + (item.lens_mount ? item.lens_mount + " mount" : "");
      prepared={ranges:focalLengths(alias),words:tokenize(mounted),coreWords:tokenize(withoutApertureSpecification(normalize(alias)) + " " + (item.lens_mount ? item.lens_mount + " mount" : ""))};
      cache?.set(key,prepared);
    } else if(!prepared.coreWords){
      prepared.coreWords=tokenize(withoutApertureSpecification(normalize(alias)) + " " + (item.lens_mount ? item.lens_mount + " mount" : ""));
    }
    return prepared;
  };
  const surfaceMatches = (item:T, alias:string, core=false) => {
    const prepared=preparedSurface(item,alias);
    const ranges=prepared.ranges;
    if (ranges.length !== 1 || ranges[0][0] !== focal[0][0] || ranges[0][1] !== focal[0][1]) return false;
    const recordedMount=item.lens_mount?.match(/\b(ef|rf|pl|e|l)\b/i)?.[1]?.toLowerCase()
      ?? normalize(alias).match(/\b(ef|rf|pl|e|l)\b/i)?.[1]?.toLowerCase();
    if(mount && recordedMount && mount!==recordedMount)return false;
    const words=core ? prepared.coreWords! : prepared.words;
    return (core ? queryCore : query).every(t => words.has(t));
  };
  const exactMatches=items.filter(item => item.kind === "lens" && surfaces(item).some(alias => surfaceMatches(item,alias)));
  if(exactMatches.length===1)return {explicit:true,item:exactMatches[0]};
  if(exactMatches.length>1 || !hasApertureSpecification(name))return {explicit:true,item:null as T|null};

  // Some legacy stock rows omit aperture even though the advertised listing
  // states it. Only bridge that gap when the maker, focal range, and remaining
  // model identity identify exactly one master item and none of its recorded
  // surfaces specifies a competing aperture. Unknown or conflicting models
  // remain unresolved rather than being guessed into stock.
  const baseMatches=items.filter(item => item.kind === "lens" && surfaces(item).some(alias => surfaceMatches(item,alias,true)));
  if(baseMatches.length!==1 || surfaces(baseMatches[0]).some(hasApertureSpecification))return {explicit:true,item:null as T|null};
  return {explicit:true,item:baseMatches[0]};
}
