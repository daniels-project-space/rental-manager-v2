import { tokenize } from "./item_name_match";

type Lens = { _id: unknown; name_canonical: string; aliases?: string[]; kind?: string; lens_mount?: string | null };
const labels = tokenize("lens lenses zoom telephoto full frame mount");
const normalize = (text:string) => text.replace(/\bg\s*-?\s*master\b/gi,"GM").replace(/\bL[ -]series\b/gi,"")
  .replace(/\bSony\s+FE\b/gi,"Sony E");
function focalLengths(text: string) {
  const matches = [...text.replace(/[–—−]/g, "-").matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:mm)?\b|(?<![\w.])(\d+(?:\.\d+)?)\s*mm\b/gi)];
  return matches.map(m => m[3] ? [Number(m[3]), Number(m[3])] : [Number(m[1]), Number(m[2])]);
}

/** A supplied lens label may omit "GM" or add "zoom lens". Require its exact
 * focal range and every stated model token, then a unique master identity.
 * No ranking, ownership preference, generation guess or zoom/prime substitution. */
export function declaredLensIdentity<T extends Lens>(name: string, items: T[], cache?:Map<string,{ranges:number[][];words:Set<string>}>) {
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
  const matches = items.filter(item => item.kind === "lens" && [item.name_canonical, ...(item.aliases ?? [])].some(alias => {
    const key=JSON.stringify([alias,item.lens_mount]);
    let prepared=cache?.get(key);
    if(!prepared){prepared={ranges:focalLengths(alias),words:tokenize(normalize(alias) + " " + (item.lens_mount ? item.lens_mount + " mount" : ""))};cache?.set(key,prepared);}
    const ranges = prepared.ranges;
    if (ranges.length !== 1 || ranges[0][0] !== focal[0][0] || ranges[0][1] !== focal[0][1]) return false;
    const recordedMount=item.lens_mount?.match(/\b(ef|rf|pl|e|l)\b/i)?.[1]?.toLowerCase()
      ?? normalize(alias).match(/\b(ef|rf|pl|e|l)\b/i)?.[1]?.toLowerCase();
    if(mount && recordedMount && mount!==recordedMount)return false;
    const words = prepared.words;
    return query.every(t => words.has(t));
  }));
  return { explicit: true, item: matches.length === 1 ? matches[0] : null };
}
