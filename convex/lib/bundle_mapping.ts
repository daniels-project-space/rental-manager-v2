import { bestMatch } from "./item_name_match";
import { isStandardAccessory } from "./reservations/itemUnits";
import { extractComponents } from "./bundle_description_parse";

type Inventory = { _id: unknown; name_canonical: string; kind?: string; qty?: number; aliases?: string[]; lens_mount?: string | null };
const mountTokens = new Set(["ef", "l", "rf", "e", "pl", "mount"]);
const tokens = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  .map(token => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token);
const incidental = /\b(?:batter(?:y|ies)|chargers?|cables?|carrying (?:bag|case)|(?:camera )?cage|(?:sd|memory) cards?|(?:cfexpress|sdxc|sdhc)\b[^.;]{0,50}\bcard|ssds?|\d+\s*(?:tb|gb)\s+(?:card|media))\b/i;

/** Contents identity and stated quantities, independently of whether we own them. */
export function resolveBundleMapping(description: string, items: Inventory[]) {
  const { components, usedBullets, hasContentsSection } = extractComponents(description);
  const resolved: Array<{item_id:string;name:string;qty:number;kind:string}> = [];
  const unmatched: string[] = [];
  for (const component of components) {
    // Recording media/power supplied with a body are described by its owner
    // inventory record. A "5x batteries" line is not five battery-pack rentals.
    const majorEquipment = /\b(?:camera(?!\s+(?:batter|cage))|bmpcc|blackmagic|fx\d|a7\w*|gimbal|lens(?:es)?|tripod|mic(?:rophone)?|rig|monitor|lights?|led)\b/i;
    if (incidental.test(component.name) && !majorEquipment.test(component.name)) continue;
    const name = component.name.replace(/\bdzo(?:film)?\b/gi, "DZOFilm");
    const lineTokens = new Set(tokens(name));
    const explicitMount = name.match(/\bCanon\s+(EF|RF)\b|\b(EF|RF|PL|E|L)[ -]?mount\b/i);
    const mount = (explicitMount?.[1] ?? explicitMount?.[2])?.toLowerCase();
    const candidates = items.filter(item => {
      const recordedMount = item.lens_mount?.toLowerCase().match(/\b(ef|rf|pl|e|l)\b/)?.[1]
        ?? item.name_canonical.toLowerCase().match(/\b(ef|rf|pl)\b/)?.[1];
      return !mount || !recordedMount || mount === recordedMount;
    });
    let picked: Inventory | null = null;
    let specificity = 0;
    let ambiguous = false;
    for (const item of candidates) {
      if (isStandardAccessory(item.kind, item.name_canonical)) continue;
      const aliases = [item.name_canonical, ...(item.aliases ?? [])];
      // A missing aperture or set size may be omitted from a contents line.
      // Keep explicit values and require a unique manufacturer/model identity.
      if (item.kind === "lens" && !/\b[ft]\s*\/?\d/i.test(name))
        aliases.push(item.name_canonical.replace(/\b[ft]\s*\/?\d+(?:\.\d+)?\b/gi, ""));
      if (!/\b\d+[ -]+lens\b/i.test(name))
        aliases.push(item.name_canonical.replace(/\b\d+[ -]+lens\b/gi, "lens"));
      for (const alias of aliases) {
        const all = tokens(alias);
        const stripped = all.filter(token => !mountTokens.has(token));
        const required = stripped.length >= 2 ? stripped : all;
        if (required.length < 2 || !required.every(token => lineTokens.has(token))) continue;
        if (required.length > specificity) { picked = item; specificity = required.length; ambiguous = false; }
        else if (required.length === specificity && picked?._id !== item._id) ambiguous = true;
      }
    }
    const match = !ambiguous && picked ? picked : bestMatch(name, candidates, item => item.name_canonical, item => item.aliases ?? []);
    const item = ambiguous ? null : "name_canonical" in match ? match : match.match && match.confident ? match.match : null;
    if (!item || !Number.isInteger(component.qty) || component.qty < 1) { unmatched.push(`${component.qty}x ${component.name}`); continue; }
    if (isStandardAccessory(item.kind, item.name_canonical)) continue;
    const existing = resolved.find(row => row.item_id === String(item._id));
    // Explicit contents bullets state units; stock capacity must not reduce them.
    if (existing) existing.qty += component.qty;
    else resolved.push({ item_id: String(item._id), name: item.name_canonical, qty: component.qty, kind: item.kind ?? "unknown" });
  }
  return { components: resolved, unmatched, structured: usedBullets, explicit: hasContentsSection };
}
