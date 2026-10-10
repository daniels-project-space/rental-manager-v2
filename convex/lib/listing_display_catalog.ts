import { requestedDisplayMatch } from "./quick_reply_requested_items";
import type { QueryCtx } from "../_generated/server";
import { listingDisplayName } from "./item_display_name";

/** One shared catalog per query; never an N-per-card database lookup. */
export async function listingDisplayCatalog(ctx: QueryCtx, account?: string) {
  const [items, mappings, names] = await Promise.all([
    ctx.db.query("items").collect(),
    account
      ? ctx.db
          .query("listing_resolution_override")
          .withIndex("by_account_product", (q) => q.eq("account_slug", account))
          .collect()
      : ctx.db.query("listing_resolution_override").collect(),
    account
      ? ctx.db
          .query("listing_short_names")
          .withIndex("by_account_product", (q) => q.eq("account_slug", account))
          .collect()
      : ctx.db.query("listing_short_names").collect(),
  ]);
  const itemMap = new Map(items.map((i) => [String(i._id), i]));
  const mappingMap = new Map(
    mappings.map((m) => [`${m.account_slug}#${m.product_id}`, m]),
  );
  const manualMap = new Map(
    names
      .filter((n) => n.derivation_method === "manual")
      .map((n) => [`${n.account_slug}#${n.product_id}`, n.short_name]),
  );
  const imageReads = new Map<string, Promise<string[]>>();
  const readImages = (slug: string, pid: number) => {
    const key = `${slug}#${pid}`;
    if (!imageReads.has(key))
      imageReads.set(
        key,
        Promise.all([
          ctx.db
            .query("online_listings")
            .withIndex("by_account_product", (q) =>
              q.eq("account_slug", slug).eq("product_id", pid),
            )
            .first(),
          ctx.db
            .query("listing_images")
            .withIndex("by_account_product", (q) =>
              q.eq("account_slug", slug).eq("product_id", pid),
            )
            .first(),
        ]).then(([listing, bank]) => [
          ...new Set(
            [listing?.image, bank?.image_url].filter(
              (url): url is string => typeof url === "string" && !!url,
            ),
          ),
        ]),
      );
    return imageReads.get(key)!;
  };
  const imageChoicesFor = async (slug: string, pids: number[]) =>
    new Map(
      await Promise.all(
        [...new Set(pids)]
          .slice(0, 100)
          .map(async (pid) => [pid, await readImages(slug, pid)] as const),
      ),
    );
  const imagesFor = async (slug: string, pids: number[]) =>
    new Map(
      [...(await imageChoicesFor(slug, pids))]
        .filter(([, urls]) => urls.length)
        .map(([pid, urls]) => [pid, urls[0]]),
    );
  const canonicalImageReads = new Map<string, Promise<string[]>>();
  const imageChoicesForName = (slug: string, name: string) => {
    const item = requestedDisplayMatch(name, items);
    if (!item) return Promise.resolve([] as string[]);
    const key = `${slug}#${item._id}`;
    // Display fallback: at most two exact one-item owner mappings per canonical
    // model, cached across the queue. No fuzzy match or stock identity inference.
    if (!canonicalImageReads.has(key)) {
      const exact = mappings
        .filter(
          (m) =>
            m.components?.length === 1 &&
            m.components[0].item_id === item._id &&
            m.components[0].qty === 1,
        )
        .sort(
          (a, b) =>
            Number(b.account_slug === slug) - Number(a.account_slug === slug) ||
            a.product_id - b.product_id,
        )
        .slice(0, 2);
      canonicalImageReads.set(
        key,
        Promise.all(
          exact.map((m) => readImages(m.account_slug, m.product_id)),
        ).then((groups) => [
          ...new Set(
            [...groups.flat(), item.image_url].filter(
              (url): url is string => typeof url === "string" && !!url,
            ),
          ),
        ]),
      );
    }
    return canonicalImageReads.get(key)!;
  };
  return {
    items,
    mappingMap,
    itemMap,
    imagesFor,
    imageChoicesFor,
    imageChoicesForName,
    name: (accountSlug: string, pid: number, raw: string) => {
      const key = `${accountSlug}#${pid}`;
      return listingDisplayName(
        raw,
        mappingMap.get(key),
        itemMap,
        manualMap.get(key),
      );
    },
  };
}
