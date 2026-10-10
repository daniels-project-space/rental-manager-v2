/** Provider relative labels are not fabricated into absolute dates. */
export function reviewTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return text.slice(0, 200);
}
export function reviewTimeLabel(value: unknown): string {
  const text = reviewTime(value);
  if (!text) return "Date not supplied";
  return /^\d{4}-\d{2}-\d{2}T/.test(text)
    ? new Date(text).toLocaleDateString("en-GB", {
        timeZone: "Europe/London",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : text;
}
export function reviewTimestamp(row: {
  createdAt?: unknown;
  created_at?: unknown;
  date?: unknown;
  relativeLabel?: unknown;
}): string | undefined {
  return reviewTime(
    row.createdAt ?? row.created_at ?? row.date ?? row.relativeLabel,
  );
}
export function reviewFingerprint(row: {
  rating?: number;
  text?: string;
  author?: string;
}): string {
  return JSON.stringify([
    row.rating ?? null,
    row.text?.trim() ?? null,
    row.author?.trim() ?? null,
  ]);
}
