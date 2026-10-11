export function mergeOrder(saved: string[] | undefined, defaults: readonly string[]): string[] {
  // Insert new (unsaved) ids at their declared default position, while preserving
  // the user's relative order between ids they have already saved. Without this,
  // a newly-added DEFAULT_*_ORDER entry (e.g. WallE at index 0) gets appended to
  // the end of a pre-existing saved layout instead of landing at its default slot.
  if (!saved || saved.length === 0) return [...defaults];
  const knownDefaults = new Set(defaults);
  const savedKnown = saved.filter((id) => knownDefaults.has(id));
  const savedSet = new Set(savedKnown);
  const result: string[] = [];
  let savedIdx = 0;
  for (const defId of defaults) {
    if (!savedSet.has(defId)) {
      // new widget — insert at default position
      result.push(defId);
    } else {
      // emit saved ids up to and including this one (preserves user reorders between known ids)
      while (savedIdx < savedKnown.length && savedKnown[savedIdx] !== defId) {
        result.push(savedKnown[savedIdx++]);
      }
      if (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
    }
  }
  while (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
  return result;
}


export function upgradePanelOrder(saved: string[] | undefined, defaults: readonly string[]) {
  const merged = mergeOrder(saved, defaults);
  if (saved?.includes("live-calendar")) return merged;
  const core = ["stats-grid", "lifetime", "reply-inbox", "live-calendar", "return-hub"];
  return [...core, ...merged.filter((id) => !core.includes(id))];
}
