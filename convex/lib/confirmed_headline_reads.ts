export const MAX_RENTAL_HEADLINE_WINDOW_ROWS = 1_500;

type BoundedQuery<T> = {
  take(limit: number): Promise<T[]>;
};

/** Read a capped indexed window and fail visibly instead of silently truncating KPIs. */
export async function takeRentalHeadlineWindow<T>(
  query: BoundedQuery<T>,
  windowName: string,
): Promise<T[]> {
  const rows = await query.take(MAX_RENTAL_HEADLINE_WINDOW_ROWS + 1);
  if (rows.length > MAX_RENTAL_HEADLINE_WINDOW_ROWS) {
    throw new Error(`Live rental headline window exceeded ${MAX_RENTAL_HEADLINE_WINDOW_ROWS} rows (${windowName})`);
  }
  return rows;
}

export function mergeConfirmedHeadlineWindows<T extends { _id: string }>(
  windows: readonly (readonly T[])[],
): T[] {
  const unique = new Map<string, T>();
  for (const window of windows) {
    for (const row of window) unique.set(row._id, row);
  }
  return [...unique.values()];
}
