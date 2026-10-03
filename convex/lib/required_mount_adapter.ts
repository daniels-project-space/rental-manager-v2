import { normalizeMount } from "./item_name_match";

export type MountItem = { id: string; name: string; kind?: string; mount?: string | null };
export type MountUnit = { item_id: string; quantity: number };

/** Count adapters for the whole basket, so two lenses sharing one camera do not sell two adapters. */
export function requiredMountAdapters(items: MountItem[], existing: MountUnit[], added: MountUnit[], renterProvided: MountUnit[] = []) {
  const cameras = existing.filter(unit => ["camera", "camera_body"].includes(items.find(i => i.id === unit.item_id)?.kind ?? ""));
  const addedLenses = added.filter(unit => items.find(i => i.id === unit.item_id)?.kind === "lens");
  if (!addedLenses.length || !cameras.length) return { status: "none" as const, items: [] as Array<{ item_id: string; name: string; quantity: number }> };
  const destination = new Set(cameras.map(unit => normalizeMount(items.find(i => i.id === unit.item_id)?.mount)));
  if (destination.size !== 1 || destination.has("")) return { status: "unknown" as const, items: [], reason: "Confirm which camera the lens must fit." };
  const to = [...destination][0];
  const from = new Set(addedLenses.map(unit => normalizeMount(items.find(i => i.id === unit.item_id)?.mount)));
  if (from.has("")) return { status: "unknown" as const, items: [], reason: "The lens mount is unverified." };
  const required: Array<{ item_id: string; name: string; quantity: number }> = [];
  for (const mount of from) {
    if (mount === to) continue;
    const adapters = items.filter(item => {
      const match = /^\s*(.+?)\s+to\s+(.+?)\s+mount(?:\s+adapter)?\s*$/i.exec(item.name);
      return match && normalizeMount(match[1]) === mount && normalizeMount(match[2]) === to;
    });
    if (adapters.length !== 1) return { status: "unknown" as const, items: [], reason: "The exact owned mount adapter is missing or ambiguous." };
    const adapter = adapters[0];
    const lensCount = [...existing, ...added].filter(unit => {
      const item = items.find(i => i.id === unit.item_id);
      return item?.kind === "lens" && normalizeMount(item.mount) === mount;
    }).reduce((sum, unit) => sum + unit.quantity, 0);
    const cameraCount = cameras.reduce((sum, unit) => sum + unit.quantity, 0);
    const supplied = [...existing, ...added, ...renterProvided].filter(unit => unit.item_id === adapter.id).reduce((sum, unit) => sum + unit.quantity, 0);
    const quantity = Math.max(0, Math.min(cameraCount, lensCount) - supplied);
    if (quantity) required.push({ item_id: adapter.id, name: adapter.name, quantity });
  }
  return { status: required.length ? "required" as const : "none" as const, items: required };
}

/** Only a direct current renter declaration; quoted advice and negated ownership do not count. */
export function renterProvidedAdapters(text: string, items: MountItem[], prior: MountUnit[] = []): MountUnit[] {
  const units = new Map(prior.map(unit => [unit.item_id, unit.quantity]));
  for (const item of items) {
    const adapter = /^\s*(.+?)\s+to\s+(.+?)\s+mount(?:\s+adapter)?\s*$/i.exec(item.name);
    if (!adapter) continue;
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pair = new RegExp(`\\b${escape(adapter[1].trim())}\\s*(?:[-–]?\\s*to\\s*[-–]?|[-–→])\\s*${escape(adapter[2].trim())}\\s*(?:mount\\s*)?adapt(?:er|or)s?\\b`, "i");
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const match = pair.exec(sentence);
      if (match && /^\s*(?:i\b|i've\b|my\b)/i.test(sentence) && /\b(?:don't have|do not have|no longer have|have no|lost|broken|doesn't work|not working)\b/i.test(sentence)) {
        units.delete(item.id);
        continue;
      }
      if (!/^\s*i\s+(?:already\s+)?(?:have|own|have got)\b/i.test(sentence) || !match ||
        /\b(?:no|not|don't|do not|haven't|have not)\b/i.test(sentence.slice(0, match.index)) ||
        /\b(?:broken|does not fit|doesn't fit|doesn't work|not working|lost)\b/i.test(sentence)) continue;
      const count = /^\s*i\s+(?:already\s+)?(?:have|own|have got)\s+(?:(?:my\s+)?own\s+)?(\d+)\b/i.exec(sentence);
      const quantity = count ? Number(count[1]) : 1;
      if (Number.isInteger(quantity) && quantity > 0 && quantity <= 20) units.set(item.id, quantity);
      break;
    }
  }
  return [...units].map(([item_id, quantity]) => ({ item_id, quantity }));
}
