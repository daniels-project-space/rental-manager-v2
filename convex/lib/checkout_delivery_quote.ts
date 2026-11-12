/** Read the public DB Cinema checkout for an exact DB Cinema listing basket.
 * This function neither starts checkout nor creates a customer or booking. */
const CHECKOUT_URL = "https://zany-wolf-18.convex.cloud";
type CheckoutLine = { productId: number; qty: number };

export async function checkoutDeliveryQuote(
  input: { account: string; postcode: string; startDate: string; endDate: string; items: CheckoutLine[] },
  fetcher: typeof fetch = fetch,
): Promise<{ fee: number; km: number; vehicle: string } | null> {
  if (input.account !== "dbcinema" || !/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(input.postcode.trim()) ||
      !input.items.length || input.items.length > 8 ||
      input.items.some(item => !Number.isSafeInteger(item.productId) || item.productId < 1 ||
        !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 20) ||
      new Set(input.items.map(item => item.productId)).size !== input.items.length ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) return null;
  const start = Date.parse(`${input.startDate}T12:00:00Z`), end = Date.parse(`${input.endDate}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      new Date(start).toISOString().slice(0, 10) !== input.startDate ||
      new Date(end).toISOString().slice(0, 10) !== input.endDate) return null;

  async function call(kind: "query" | "action", path: string, args: unknown): Promise<unknown> {
    const response = await fetcher(`${CHECKOUT_URL}/api/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Checkout request failed");
    const result = await response.json() as { status?: string; value?: unknown };
    if (result.status !== "success") throw new Error("Checkout request failed");
    return result.value;
  }
  try {
    // The site's sync creates slugs ending in the exact DB Cinema Hygglo
    // product ID. Scan all bounded public discovery pages so a duplicate or
    // incomplete result cannot silently select another offer.
    let cursor: string | null = null, done = false;
    const matches = new Map<number, string[]>();
    for (let pageNumber = 0; pageNumber < 8 && !done; pageNumber++) {
      const result = await call("query", "catalog:discovery", { paginationOpts: { numItems: 200, cursor } }) as
        { page?: Array<{ slug?: unknown }>; isDone?: unknown; continueCursor?: unknown };
      if (!Array.isArray(result?.page) || typeof result.isDone !== "boolean") return null;
      for (const row of result.page) {
        if (typeof row.slug !== "string") continue;
        const suffix = /-(\d+)$/.exec(row.slug);
        if (!suffix) continue;
        const id = Number(suffix[1]);
        if (input.items.some(item => item.productId === id)) matches.set(id, [...(matches.get(id) ?? []), row.slug]);
      }
      done = result.isDone;
      if (!done && (typeof result.continueCursor !== "string" || !result.continueCursor || result.continueCursor === cursor)) return null;
      cursor = done ? null : result.continueCursor as string;
    }
    if (!done || input.items.some(item => matches.get(item.productId)?.length !== 1)) return null;
    const listingIds: string[] = [];
    for (const item of input.items) {
      const slug = matches.get(item.productId)![0];
      const listing = await call("query", "catalog:getListingBySlug", { slug }) as
        { _id?: unknown; slug?: unknown; bookable?: unknown; marketingOnly?: unknown } | null;
      if (!listing || listing.slug !== slug || typeof listing._id !== "string" || !listing._id ||
          listing.bookable !== true || listing.marketingOnly !== false) return null;
      for (let i = 0; i < item.qty; i++) listingIds.push(listing._id);
    }
    const quote = await call("action", "delivery:quote", {
      postcode: input.postcode, groups: [{ start, end, listingIds }],
    }) as { ok?: unknown; fee?: unknown; km?: unknown; vehicle?: unknown; groups?: unknown } | null;
    if (!quote || quote.ok !== true || !Number.isSafeInteger(quote.fee) || (quote.fee as number) <= 0 ||
        (quote.fee as number) > 10000 || typeof quote.km !== "number" || !Number.isFinite(quote.km) ||
        quote.km < 0 || typeof quote.vehicle !== "string" || !["motorcycle", "car", "van"].includes(quote.vehicle) ||
        !Array.isArray(quote.groups) || quote.groups.length !== 1 ||
        quote.groups[0]?.start !== start || quote.groups[0]?.end !== end || quote.groups[0]?.fee !== quote.fee) return null;
    return { fee: quote.fee as number, km: quote.km, vehicle: quote.vehicle };
  } catch { return null; }
}
