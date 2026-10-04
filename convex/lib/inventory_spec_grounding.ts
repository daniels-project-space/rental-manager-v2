import { verifiedItemSpec, type SpecRecord } from "./verified_item_spec";

export function ownedInventoryItem(item: {status: string; is_marketing_only?: boolean; qty: number}) {
  return item.status === "active" && !item.is_marketing_only && item.qty > 0;
}

/** Join by the physical item ID, then verify its exact canonical identity.
 * Multiple spec rows require review rather than selecting a convenient row. */
export function inventorySpecMap<T extends SpecRecord & {item_id:unknown}>(rows:T[]) {
  const map = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const key = String(row.item_id);
    if (ambiguous.has(key)) continue;
    if (map.has(key)) { map.delete(key); ambiguous.add(key); }
    else map.set(key, row);
  }
  return map;
}

export function inventorySpec(spec: SpecRecord | undefined, name: string) {
  const verified = verifiedItemSpec(spec, name);
  return verified && spec ? {
    description: spec.description, specs_long: spec.specs_long ?? null,
    text: verified.text, model: verified.model, source_url: verified.source_url,
  } : null;
}

/** Brand and mount do not prove autofocus. Only reviewed lens prose qualifies.
 * Manual override on an autofocus lens does not make it manual-only. */
export function verifiedLensFocus(kind: string | undefined, text: string | undefined): "autofocus" | "manual_focus" | null {
  if (kind !== "lens" || !text) return null;
  const s = text.toLowerCase();
  if (/\b(?:manual[- ]focus only|no autofocus|no af|without autofocus)\b/.test(s)) return "manual_focus";
  if (/\b(?:autofocus|auto-focus|linear motor|stepping motor)\b/.test(s)) return "autofocus";
  if (/\b(?:manual[- ]focus|focus by hand)\b/.test(s)) return "manual_focus";
  return null;
}
