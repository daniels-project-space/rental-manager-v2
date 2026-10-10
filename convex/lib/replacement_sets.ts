/** Bounded complete-set search. A partial choice is never an approved plan. */
export async function replacementSets<T>(
  groups: T[][],
  identity: (item: T) => string,
  qualifies: (set: T[]) => Promise<boolean>,
  limit = 2,
  budget = 128,
) {
  const sets: T[][] = [];
  let examined = 0;
  let limited = false;
  async function walk(selected: T[], index: number): Promise<void> {
    if (sets.length >= limit || limited) return;
    if (index === groups.length) {
      if (++examined > budget) {
        limited = true;
        return;
      }
      if (await qualifies(selected)) sets.push(selected);
      return;
    }
    for (const candidate of groups[index]) {
      if (selected.some((item) => identity(item) === identity(candidate)))
        continue;
      await walk([...selected, candidate], index + 1);
      if (sets.length >= limit || limited) break;
    }
  }
  if (
    groups.length &&
    groups.length <= 8 &&
    groups.every((group) => group.length)
  )
    await walk([], 0);
  return { sets, limited, examined };
}
