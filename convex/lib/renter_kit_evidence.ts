/** Merge server-read kit facts; an empty listing description cannot negate a mapped kit. */
export function unknownKitItems(routeUnknown: string[], listings: { name: string; description?: string | null }[], knownKitItems: string[]) {
  const known = new Set([...knownKitItems, ...listings.filter(l => !!l.description?.trim()).map(l => l.name)]);
  return [...new Set([...routeUnknown, ...listings.filter(l => !l.description?.trim()).map(l => l.name)])].filter(name => !!name && !known.has(name));
}
