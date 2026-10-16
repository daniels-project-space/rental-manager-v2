export type RequestedImageItem = {
  name: string;
  display_name?: string;
  canonical_name?: string;
  qty: number;
  image_url: string | null;
  image_urls?: string[];
  product_id?: number;
  origin?: "basket" | "chat";
};
type CatalogueItem = {
  name_canonical: string;
  aliases?: string[];
  image_url?: string;
};
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type CatalogueIndex<T extends CatalogueItem> = {
  aliasesByItem: Map<T, string[]>;
  exact: Map<string, T[]>;
  reordered: Map<string, T[]>;
  chatAliasesByItem: Map<T, string[]>;
};

// listingDisplayCatalog creates one immutable inventory array per query. Keep
// its normalized lookup tables for the duration of that query so every tile
// does not rebuild aliases (and re-scan the catalogue to prove uniqueness).
const catalogueIndexes = new WeakMap<CatalogueItem[], CatalogueIndex<CatalogueItem>>();

function catalogueIndex<T extends CatalogueItem>(catalogue: T[]): CatalogueIndex<T> {
  const cached = catalogueIndexes.get(catalogue);
  if (cached) return cached as CatalogueIndex<T>;

  const aliasesByItem = new Map<T, string[]>();
  const exact = new Map<string, T[]>();
  const reordered = new Map<string, T[]>();
  const owners = new Map<string, Set<T>>();
  for (const item of catalogue) {
    const aliases = [...new Set([item.name_canonical, ...(item.aliases ?? [])].map(key).filter(Boolean))];
    aliasesByItem.set(item, aliases);
    for (const alias of aliases) {
      const exactRows = exact.get(alias) ?? [];
      exactRows.push(item);
      exact.set(alias, exactRows);

      const tokenKey = alias.split(" ").sort().join(" ");
      const reorderedRows = reordered.get(tokenKey) ?? [];
      if (!reorderedRows.includes(item)) reorderedRows.push(item);
      reordered.set(tokenKey, reorderedRows);

      const aliasOwners = owners.get(alias) ?? new Set<T>();
      aliasOwners.add(item);
      owners.set(alias, aliasOwners);
    }
  }

  const chatAliasesByItem = new Map<T, string[]>();
  for (const [item, aliases] of aliasesByItem) {
    chatAliasesByItem.set(item, aliases.filter((alias) =>
      alias.length >= 3 && (alias.includes(" ") || /\d/.test(alias)) && owners.get(alias)?.size === 1,
    ));
  }
  const result = { aliasesByItem, exact, reordered, chatAliasesByItem };
  catalogueIndexes.set(catalogue, result as CatalogueIndex<CatalogueItem>);
  return result;
}

/** Exact model tokens may be reordered by an inquiry label. This is only an
 * image/display match and must never be used as a physical stock identity. */
export function requestedDisplayMatch<T extends CatalogueItem>(
  name: string,
  catalogue: T[],
): T | null {
  const index = catalogueIndex(catalogue);
  const n = key(name);
  const exact = index.exact.get(n) ?? [];
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (!/\d/.test(n)) return null;
  const tokens = n.split(" ").sort().join(" ");
  const reordered = index.reordered.get(tokens) ?? [];
  return reordered.length === 1 ? reordered[0] : null;
}

/** Display-only context. Mentioned equipment never changes the paid basket,
 * stock receipts, replacement indices, approval or earnings. */
export function requestedImageItems(
  basket: RequestedImageItem[],
  inquiry: RequestedImageItem[],
  texts: string[],
  catalogue: CatalogueItem[],
): RequestedImageItem[] {
  const index = catalogueIndex(catalogue);
  const result: RequestedImageItem[] = [];
  const resolve = (name: string) => requestedDisplayMatch(name, catalogue);
  const add = (item: RequestedImageItem, origin: "basket" | "chat") => {
    const known = resolve(item.canonical_name ?? item.name) ?? resolve(item.display_name ?? ""),
      identity = key(known?.name_canonical ?? item.name);
    const previous = result.find(
      (row) => key(resolve(row.canonical_name ?? row.name)?.name_canonical ?? resolve(row.display_name ?? "")?.name_canonical ?? row.name) === identity,
    );
    if (previous) {
      if (origin === "basket" && previous.origin === "basket")
        previous.qty += item.qty;
      const candidates = [
        ...new Set(
          [
            previous.image_url,
            ...(previous.image_urls ?? []),
            item.image_url,
            ...(item.image_urls ?? []),
            known?.image_url,
          ].filter(Boolean),
        ),
      ] as string[];
      previous.image_url = candidates[0] ?? null;
      if (candidates.length > 1) previous.image_urls = candidates;
      return;
    }
    const imageUrls = [
      ...new Set(
        [item.image_url, ...(item.image_urls ?? []), known?.image_url].filter(
          Boolean,
        ),
      ),
    ] as string[];
    result.push({
      ...item,
      ...(imageUrls.length > 1 ? { image_urls: imageUrls } : {}),
      image_url: item.image_url ?? known?.image_url ?? null,
      origin,
    });
  };
  basket.forEach((item) => add(item, "basket"));
  inquiry.forEach((item) => add(item, "chat"));
  for (const text of texts) {
    const normalized = ` ${key(text)} `;
    const mentioned = new Set<CatalogueItem>();
    for (const item of catalogue) {
      if (index.chatAliasesByItem.get(item)?.some((alias) => normalized.includes(` ${alias} `)))
        mentioned.add(item);
    }
    for (const item of catalogue) {
      if (!mentioned.has(item)) continue;
      add(
        {
          name: item.name_canonical,
          qty: 1,
          image_url: item.image_url ?? null,
        },
        "chat",
      );
    }
  }
  return result;
}
