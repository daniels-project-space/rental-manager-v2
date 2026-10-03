type LensIdentity = { _id: unknown; kind?: string; name_canonical: string; aliases?: string[] };
const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const descriptors = /\b(?:anamorphic|lens|lenses)\b/g;

/** Expand only an explicit prime-lens family and focal list against inventory.
 * This provides lookup identities, never ownership or availability evidence. */
export function resolveLensSet<T extends LensIdentity>(name: string, inventory: T[]) {
  const match = /^([a-z][a-z\s-]*?)\s+(\d+(?:\.\d+)?\s*(?:mm)?(?:\s*(?:,|\/|and|&)\s*\d+(?:\.\d+)?\s*(?:mm)?)+)\s+(?:(?:anamorphic\s+)?(?:lens|lenses)\s+)?set$/i.exec(name.trim());
  if (!match) return null;
  const focals = [...match[2].matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  if (focals.length > 8 || focals.some(f => f <= 0) || new Set(focals).size !== focals.length)
    return { ok: false as const, reason: "invalid_lens_set_focals" };
  const family = normal(match[1].replace(descriptors, " "));
  if (!family) return { ok: false as const, reason: "lens_set_family_required" };
  const items: T[] = [];
  for (const focal of focals) {
    const matches = inventory.filter(item => item.kind === "lens" && [item.name_canonical, ...(item.aliases ?? [])].some(alias => {
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
