import { bestMatch } from "./item_name_match";
import { isStandardAccessory } from "./reservations/itemUnits";
import { extractComponents } from "./bundle_description_parse";

type Inventory = { _id: unknown; name_canonical: string; kind?: string; qty?: number; aliases?: string[]; lens_mount?: string | null; status?: string; is_marketing_only?: boolean; track_independent_stock?: boolean };
const mountTokens = new Set(["ef", "l", "rf", "e", "pl", "mount"]);
const tokens = (text: string) => (text.toLowerCase().replace(/\bg\s*-?\s*master\b/g, "gm").match(/[a-z0-9]+/g) ?? [])
  .map(token => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token);
const incidental = /\b(?:batter(?:y|ies)|chargers?|cables?|carrying (?:bag|case)|uv\s+filters?|(?:camera )?cage|(?:sd|memory) cards?|(?:cfexpress|sdxc|sdhc)\b[^.;]{0,50}\bcard|ssds?|\d+\s*(?:tb|gb)\s+(?:card|media))\b/i;

/** Contents identity and stated quantities, independently of whether we own them. */
export function resolveBundleMapping(description: string, items: Inventory[]) {
  const { components, usedBullets, hasContentsSection } = extractComponents(description);
  const resolved: Array<{item_id:string;name:string;qty:number;kind:string}> = [];
  const unmatched: string[] = [];
  for (const component of components) {
    // A second leading count is malformed/ambiguous contents, not a model
    // token to discard while adopting the outer quantity (e.g. 1x 3x cameras).
    if (/^\d{1,2}\s*x\s+/i.test(component.name)) {
      unmatched.push(`Ambiguous quantity: ${component.qty}x ${component.name}`); continue;
    }
    // Generic bundled accessories must not become battery-pack rentals.
    // Named independently tracked pools still participate in kit coverage.
    const majorEquipment = /\b(?:camera(?!\s+(?:batter|cage))|bmpcc|blackmagic|fx\d|a7\w*|gimbal|lens(?:es)?|tripod|mic(?:rophone)?|rig|monitor|lights?|led)\b/i;
    const incidentalComponent = incidental.test(component.name) && !majorEquipment.test(component.name);
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
      if (isStandardAccessory(item.kind, item.name_canonical) && item.track_independent_stock !== true) continue;
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
    // An incidental line needs the full canonical/alias identity, not a fuzzy
    // guess from "batteries" or "card" to an unrelated stock pool.
    const match = !ambiguous && picked ? picked : incidentalComponent ? null : bestMatch(name, candidates, item => item.name_canonical, item => item.aliases ?? []);
    const item = ambiguous || !match ? null : "name_canonical" in match ? match : match.match && match.confident ? match.match : null;
    if (!item && incidentalComponent && !ambiguous) continue;
    if (!item || !Number.isInteger(component.qty) || component.qty < 1) { unmatched.push(`${component.qty}x ${component.name}`); continue; }
    if (isStandardAccessory(item.kind, item.name_canonical) && item.track_independent_stock !== true) continue;
    const existing = resolved.find(row => row.item_id === String(item._id));
    // Explicit contents bullets state units; stock capacity must not reduce them.
    if (existing) existing.qty += component.qty;
    else resolved.push({ item_id: String(item._id), name: item.name_canonical, qty: component.qty, kind: item.kind ?? "unknown" });
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
