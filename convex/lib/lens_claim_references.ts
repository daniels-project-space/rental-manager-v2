/** Narrow references derived from exact native item identities. A kit title
 * mentioning a lens must never lend the kit's stock or price to that lens. */
export function lensClaimReferences<T extends { names: string[] }>(entries: T[], sameIdentity: (a: string[], b: string[]) => boolean) {
  const owners = new Map<string, T[]>();
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const entry of entries) for (const name of entry.names) {
    if (/[+]|\b(?:kit|set|bundle|with|and|plus|camera|body|bmpcc|blackmagic|pyxis|fx\d+|a7\s*(?:ii|iii|iv|v|\d+)|adapter|converter|filter|case|bag|cage|gimbal|tripod|battery|batteries|charger|card|monitor|mic|microphone|rig|screen|cap)\b/i.test(name)) continue;
    const ranges = [...name.matchAll(/\b(\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*mm)\b/gi)];
    if (ranges.length !== 1) continue;
    const range = ranges[0];
    const keys = [normalize(range[1])];
    const prefix = name.slice(0, range.index).trim();
    // Preserve a stated brand/mount prefix as well as the bare range. Each
    // reference must still have one identity across all matching entries.
    if (/^[a-z][a-z\s-]*$/i.test(prefix)) {
      keys.push(normalize(`${prefix} ${range[1]}`));
      keys.push(normalize(`${prefix.split(/\s+/)[0]} ${range[1]}`));
    }
    for (const key of new Set(keys)) {
      const matches = owners.get(key) ?? [];
      if (!matches.includes(entry)) matches.push(entry);
      owners.set(key, matches);
    }
  }
  const references = new Map<string, T>();
  for (const [key, matches] of owners) {
    if (matches.every(entry => sameIdentity(entry.names, matches[0].names))) references.set(key, matches[0]);
  }
  return references;
}
