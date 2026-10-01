import { isStandardAccessory } from "./reservations/itemUnits";

export type DisplayItem = { _id?: unknown; name_canonical: string; display_name?: string; kind?: string };
type DisplayMapping = { components: Array<{ item_id: unknown; qty: number }> };
// Presentation names never replace item IDs, canonical matching or price lookup.
const NAMES: Record<string, string> = {
  "GoPro 12 Hero": "GoPro HERO12 Black",
  "Sony GM 90mm f2.8": "Sony 90mm f/2.8 Macro G OSS",
  "Sony FE 90mm f2.8 Macro G OSS": "Sony 90mm f/2.8 Macro G OSS",
  "DJI Osmo Action Pro 5": "DJI Osmo Action 5 Pro",
  "DJ RX3 Pioneer controller": "Pioneer XDJ-RX3",
  "MACKIE Thump Go speaker": "Mackie Thump GO",
  "DJI RS3 Pro gimbal": "DJI RS3 Pro",
  "Small rig tripod": "SmallRig tripod",
  "EF to L mount": "EF → L adapter",
  "PL to L mount": "PL → L adapter",
  "PL to EF mount": "PL → EF adapter",
  "PL to RF mount": "PL → RF adapter",
  "PL to Sony E mount": "PL → E adapter",
  "CF Express Type A card": "CFexpress Type A card",
  "Tilta Nucleus Nano 2 follow focus": "Tilta Nucleus Nano II",
  "Rode Video Mic Pro Plus": "RØDE VideoMic Pro+",
  "Rode Video Mic Go": "RØDE VideoMic GO",
  "Rode Wireless Mic Pro set": "RØDE Wireless PRO",
};

export function shortItemName(item: DisplayItem | string): string {
  if (typeof item !== "string" && item.display_name?.trim()) return item.display_name.trim();
  const name = typeof item === "string" ? item : item.name_canonical;
  return (NAMES[name] ?? name).replace(/^Anamorphic (Blazar Remus|Great Joy) lens?\s*/i, "$1 ")
    .replace(/^Anamorphic (Blazar Remus|Great Joy)\s*/i, "$1 ")
    .replace(/^Sony GM (.*)/, "Sony $1 GM").replace(/\s+/g, " ").trim();
}

/** Conservative fallback when a listing has no trustworthy inventory mapping.
 * Keep Full Frame, Pro, 4K and model suffixes: these distinguish actual models. */
export function shortListingTitle(title: string): string {
  const primary = title.split(/\s*[|+]\s*|\s\/\s|\s[–—]\s/)[0].replace(/\([^)]*\)/g, " ").trim();
  const qty = primary.match(/^(\d+)\s*[x×]\s*/i)?.[1];
  const prefix = qty ? `${qty}× ` : "";
  let match: RegExpMatchArray | null;
  if ((match = primary.match(/\bSony\s*a7\s*(s\s*(?:III|II|IV)|III|II|IV|V|[1-5])\b/i))) {
    const model = match[1].toUpperCase().replace(/\s+/g, " ");
    return `${prefix}Sony A7${model.startsWith("S") ? model.replace(/^S\s*/, "S ") : ` ${model}`}`;
  }
  if ((match = primary.match(/\b(?:Senheiser|Sennheiser)\s*(?:Radio\s+mic\s+microphone\s*)?(G[23])\b/i))) return `${prefix}Sennheiser ${match[1].toUpperCase()} wireless mic`;
  if ((match = primary.match(/\bBlazar\s+Remus.*?\b(\d+)\s*mm\b/i))) return `${prefix}Blazar Remus ${match[1]}mm`;
  if ((match = primary.match(/\bDZO\s*Film\s+Vespid.*?\b(\d+)\s*mm\b/i))) return `${prefix}DZOFilm Vespid ${match[1]}mm`;
  if ((match = primary.match(/\bDZO\s*ARLES.*?\b([356])\s*(?:lenses|x)\b/i))) return `DZOFilm ARLES ${match[1]}-lens set`;
  if ((match = primary.match(/\bAtlas\s+(Mercury|Orion)\b/i))) return `Atlas ${match[1]} lens set`;
  if (/\bGo\s*pro\s+Max\b/i.test(primary)) return `${prefix}GoPro MAX`;
  if (/\bMackie\s+(?:thumb|thump)\s+go\b/i.test(primary)) return `${prefix}Mackie Thump GO`;
  if ((match = primary.match(/\bSigma.*?\b(\d+\s*-\s*\d+)mm\s*f\/?([\d.]+)/i))) return `${prefix}Sigma ${match[1]}mm f/${match[2]} Art`;
  if (/\bTilta\s+Nucleus\s+Nano\b/i.test(primary)) return `${prefix}Tilta Nucleus Nano`;
  const clean = primary.replace(/\b(?:professional|premium|portable|mirrorless|digital)\b/gi, " ").replace(/\s+/g, " ").trim();
  const noun = clean.match(/^.*?\b(?:tripod|projector|gimbal|camera|microphone|speaker|flash|c-stand)\b/i)?.[0];
  const name = noun && noun.length >= 10 ? noun : clean;
  const words = name.split(" ");
  while (words.join(" ").length > 60 && words.length > 1) words.pop();
  return words.join(" ") || "Unnamed listing";
}

export function listingDisplayName(title: string, mapping: DisplayMapping | undefined,
  items: Map<string, DisplayItem>, manualName?: string): string {
  if (manualName?.trim()) return manualName.trim();
  if (!mapping?.components.length) return shortListingTitle(title);
  const counts = new Map<string, { item: DisplayItem; qty: number }>();
  for (const c of mapping.components) {
    const item = items.get(String(c.item_id));
    if (!item || !Number.isInteger(c.qty) || c.qty < 1) return shortListingTitle(title);
    if (isStandardAccessory(item.kind, item.name_canonical)) continue;
    const key = String(c.item_id), old = counts.get(key);
    counts.set(key, { item, qty: c.qty + (old?.qty ?? 0) });
  }
  const rank = (i: DisplayItem) => i.kind === "camera" ? 0 : i.kind === "lens" ? 1 : 2;
  const parts = [...counts.values()].sort((a, b) => rank(a.item) - rank(b.item))
    .map(({ item, qty }) => `${qty > 1 ? `${qty}× ` : ""}${shortItemName(item)}`);
  if (!parts.length) return shortListingTitle(title);
  return parts.length > 2 ? `${parts[0]} + ${parts.length - 1} items` : parts.join(" + ");
}
