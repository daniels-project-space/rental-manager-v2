/**
 * Single source of truth for per-account dashboard accent colours.
 *
 *   dbcinema → blue   (#6ea8fe)
 *   leo      → green  (#22c55e)
 *   diogo    → pink   (#ec4899)   ← third account, added 2026-06-22
 *
 * The "identity-palette" widgets (HeaderBar pill, LiveActivity dot,
 * WeeklyCalendar entry border, ReturnHub card accent) read their accent from
 * here so a new account is a one-line change instead of N scattered ternaries
 * — several of which were binary `dbcinema ? … : …` checks that silently
 * mis-coloured any third slug as leo/dbcinema.
 *
 * NOTE: the dense calendar (CalendarStrip / CalendarGantt) keeps its own
 * blue/purple/pink token palette (#3b82f6 / #a855f7 / #ec4899) for historical
 * reasons; diogo is pink in both palettes so the account always reads pink.
 */
export interface AccountTheme {
  label: string;
  /** Primary hex accent — dots, pills, calendar borders, card highlights. */
  accent: string;
}

export const ACCOUNT_THEME: Record<string, AccountTheme> = {
  dbcinema: { label: "DB Cinema", accent: "#6ea8fe" },
  leo: { label: "Leo Adams", accent: "#a855f7" },
  diogo: { label: "Diogo Valdivieso", accent: "#f97316" },
  // DB Cinema's own rental WEBSITE (db-cinema-v2 storefront), synced in as a
  // profile alongside the Hygglo accounts. Emerald to stand apart from the
  // blue Hygglo DB Cinema. 2026-06-25.
  dbcinema_web: { label: "DB Cinema Web", accent: "#10b981" },
};

/** Neutral grey for unknown / unmapped slugs. */
export const ACCOUNT_FALLBACK_ACCENT = "#8b8fa3";

export function accountAccent(slug?: string | null): string {
  return (slug && ACCOUNT_THEME[slug]?.accent) || ACCOUNT_FALLBACK_ACCENT;
}

export function accountLabel(slug?: string | null): string {
  return (slug && ACCOUNT_THEME[slug]?.label) || (slug ?? "Unknown");
}
