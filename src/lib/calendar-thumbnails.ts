export type CalendarThumbnail = { name: string; image: string | null };

export function uniqueCalendarThumbnails(items: CalendarThumbnail[]): CalendarThumbnail[] {
  const result: CalendarThumbnail[] = [];
  const byImage = new Map<string, { thumbnail: CalendarThumbnail; names: Set<string> }>();

  for (const item of items) {
    if (!item.image) {
      result.push({ ...item });
      continue;
    }

    const existing = byImage.get(item.image);
    if (existing) {
      existing.names.add(item.name);
      existing.thumbnail.name = [...existing.names].join(", ");
    } else {
      const thumbnail = { ...item };
      byImage.set(item.image, { thumbnail, names: new Set([item.name]) });
      result.push(thumbnail);
    }
  }

  return result;
}
