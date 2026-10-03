type LensIdentity = { _id: unknown; kind?: string; name_canonical: string; aliases?: string[] };
const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const descriptors = /\b(?:anamorphic|lens|lenses)\b/gi;

/** Expand only an explicit prime-lens family and focal list against inventory.
 * This provides lookup identities, never ownership or availability evidence. */
export function resolveLensSet<T extends LensIdentity>(name: string, inventory: T[]) {
  const match = /^([a-z][a-z\s-]*?)\s+(\d+(?:\.\d+)?\s*(?:mm)?(?:\s*(?:,|\/|and|&)\s*\d+(?:\.\d+)?\s*(?:mm)?)+)\s+(?:(?:anamorphic\s+)?(?:lens|lenses)\s+)?sets?$/i.exec(name.trim());
  if (!match) return null;
  const focals = [...match[2].matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  if (focals.length > 8 || focals.some(f => f <= 0) || new Set(focals).size !== focals.length)
    return { ok: false as const, reason: "invalid_lens_set_focals" };
  const family = normal(match[1].replace(descriptors, " "));
  if (!family) return { ok: false as const, reason: "lens_set_family_required" };
  const items: T[] = [];
  for (const focal of focals) {
    const matches = inventory.filter(item => item.kind === "lens" && [item.name_canonical].some(alias => {
      if (/\b(?:kit|set|bundle|with|and|plus|adapter|camera|body)\b|\+|\d\s*[-–]\s*\d/i.test(alias)) return false;
      const lengths = [...alias.matchAll(/\b(\d+(?:\.\d+)?)\s*mm\b/gi)];
      if (lengths.length !== 1 || Number(lengths[0][1]) !== focal) return false;
      // Aperture, mount and other variant tokens stay significant. Ambiguous
      // entries are never picked according to stock or marketing status.
      return normal(alias.replace(lengths[0][0], " ").replace(descriptors, " ")) === family;
    }));
    if (matches.length !== 1) return { ok: false as const, reason: matches.length ? "lens_set_identity_ambiguous" : "lens_set_identity_unverified" };
    items.push(matches[0]);
  }
  if (new Set(items.map(item => String(item._id))).size !== items.length)
    return { ok: false as const, reason: "lens_set_identity_ambiguous" };
  return { ok: true as const, items };
}

/** A family shorthand is anchored to an explicit set in the renter's latest
 * request. Receipt names supply identities, not the requested member list. */
export function requestedLensSets<T extends LensIdentity>(message: string, inventory: T[]) {
  const families = new Set(inventory.filter(i=>i.kind === "lens").map(i=> {
    const lengths=[...i.name_canonical.matchAll(/\b\d+(?:\.\d+)?\s*mm\b/gi)];
    return lengths.length===1 ? normal(i.name_canonical.replace(lengths[0][0]," ").replace(descriptors," ")) : "";
  }).filter(Boolean));
  const sets: Array<{family:string;items:T[];quantity:number;reference:string}>=[];
  for (const family of families) {
    const escaped=family.split(" ").map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("\\s+");
    const pattern=new RegExp(`\\b${escaped}\\s+\\d+(?:\\.\\d+)?\\s*(?:mm)?(?:\\s*(?:,|/|and|&)\\s*\\d+(?:\\.\\d+)?\\s*(?:mm)?)+\\s+(?:(?:anamorphic\\s+)?(?:lens|lenses)\\s+)?sets?\\b`,"gi");
    for (const match of message.matchAll(pattern)) {
      const result=resolveLensSet(match[0],inventory);
      if (!result?.ok) continue;
      const before=message.slice(0,match.index);
      if (/\b(?:several|multiple|many|few)\s*(?:sets?\s+of)?\s*$/i.test(before)) continue;
      const counts:Record<string,number>={one:1,two:2,both:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
      const count=new RegExp(`\\b(\\d+|${Object.keys(counts).join("|")})\\s*(?:x|sets?\\s+of)?\\s*$`,"i").exec(before);
      if (count && /[-\w]$/.test(before.slice(0,count.index))) continue;
      const quantity=count ? counts[count[1].toLowerCase()] ?? Number(count[1]) : 1;
      if (!Number.isInteger(quantity)||quantity<1||quantity>20) continue;
      sets.push({family,items:result.items,quantity,reference:match[0]});
    }
  }
  return sets;
}

export function lensSetSubjectFamily(subject: string) {
  return normal(subject.replace(descriptors," "));
}
