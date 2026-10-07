/** Keep the hourly chart snapshot separate by account, including website rentals. */
export function applyCurrentAccountRevenue(by: Record<string, number>, accountSlug: string | null) {
  const value = (slug: string) => !accountSlug || accountSlug === slug ? by[slug] ?? 0 : 0;
  return { dbcinemaOrganic: value("dbcinema"), dbcinemaWebOrganic: value("dbcinema_web"), leoOrganic: value("leo"), diogoOrganic: value("diogo") };
}
