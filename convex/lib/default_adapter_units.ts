import { bestMatch } from "./item_name_match";

export type AdapterInventoryItem = {
  _id: unknown; name_canonical: string; kind?: string; aliases?: string[];
  is_marketing_only?: boolean;
  compatibility?: { included_with_rental?: string[] };
};
export type PhysicalUnit = { item_id: string; qty: number };

/** Only explicitly recorded supplied adapters, never mount compatibility or
 * customary accessories. Media/battery allocation retains its existing policy. */
export function defaultAdapterUnits(item: AdapterInventoryItem, inventory: AdapterInventoryItem[]) {
  const components: PhysicalUnit[] = [];
  const unresolved: string[] = [];
  if (item.is_marketing_only || !/^camera(?:_body)?$/.test(item.kind ?? "")) return { components, unresolved };
  for (const raw of item.compatibility?.included_with_rental ?? []) {
    if (!/\badapters?\b/i.test(raw) || /\b(?:not included|not supplied|optional|without)\b/i.test(raw)) continue;
    const count = /^\s*(\d+)\s*(?:[x×]\s*|\s+)/i.exec(raw);
    const name = count ? raw.slice(count[0].length) : raw;
    const qty = count ? Number(count[1]) : /\badapters\b/i.test(raw) ? NaN : 1;
    const match = bestMatch(name, inventory, i => i.name_canonical, i => i.aliases ?? []);
    if (!match.confident || !match.match || String(match.match._id) === String(item._id) ||
      /^(?:camera(?:_body)?|lens)$/.test(match.match.kind ?? "") ||
      !(/\b(?:adapter|converter)\b/i.test(match.match.name_canonical) || /\s+to\s+.+\s+mount$/i.test(match.match.name_canonical)) ||
      !Number.isInteger(qty) || qty < 1) { unresolved.push(raw); continue; }
    const id = String(match.match._id);
    const previous = components.find(c => c.item_id === id);
    if (previous) previous.qty = Math.max(previous.qty, qty); // duplicate descriptions aren't extra units
    else components.push({item_id:id,qty});
  }
  return { components, unresolved };
}

/** Expand EACH logical listing before basket aggregation. Explicitly mapped
 * supplied adapters overlap defaults; a separate extra line adds its own units. */
export function withDefaultAdapters(units: PhysicalUnit[], inventory: AdapterInventoryItem[]) {
  const quantities = new Map<string, number>();
  for (const c of units) quantities.set(c.item_id, (quantities.get(c.item_id) ?? 0) + c.qty);
  const defaults = new Map<string, number>();
  const unresolved: string[] = [];
  for (const [id, qty] of quantities) {
    const item = inventory.find(i => String(i._id) === id);
    if (!item) continue;
    const included = defaultAdapterUnits(item, inventory);
    unresolved.push(...included.unresolved);
    for (const c of included.components) defaults.set(c.item_id, (defaults.get(c.item_id) ?? 0) + c.qty * qty);
  }
  for (const [id, qty] of defaults) quantities.set(id, Math.max(quantities.get(id) ?? 0, qty));
  return { components:[...quantities].map(([item_id,qty]) => ({item_id,qty})), unresolved };
}
