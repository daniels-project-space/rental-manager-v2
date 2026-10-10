export type RequestedImageItem = {
  name: string;
  display_name?: string;
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

/** Exact model tokens may be reordered by an inquiry label. This is only an
 * image/display match and must never be used as a physical stock identity. */
export function requestedDisplayMatch<T extends CatalogueItem>(
  name: string,
  catalogue: T[],
): T | null {
  const n = key(name),
    aliases = (item: T) =>
      [item.name_canonical, ...(item.aliases ?? [])].map(key);
  const exact = catalogue.filter((item) => aliases(item).includes(n));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (!/\d/.test(n)) return null;
  const tokens = n.split(" ").sort().join(" ");
  const reordered = catalogue.filter((item) =>
    aliases(item).some((alias) => alias.split(" ").sort().join(" ") === tokens),
  );
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
  const result: RequestedImageItem[] = [];
  const aliases = (item: CatalogueItem) =>
    [item.name_canonical, ...(item.aliases ?? [])].map(key).filter(Boolean);
  const resolve = (name: string) => requestedDisplayMatch(name, catalogue);
  const add = (item: RequestedImageItem, origin: "basket" | "chat") => {
    const known = resolve(item.name),
      identity = key(known?.name_canonical ?? item.name);
    const previous = result.find(
      (row) => key(resolve(row.name)?.name_canonical ?? row.name) === identity,
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
    for (const item of catalogue) {
      const matches = aliases(item).filter(
        (alias) =>
          alias.length >= 3 &&
          (alias.includes(" ") || /\d/.test(alias)) &&
          normalized.includes(` ${alias} `),
      );
      if (!matches.length) continue;
      // Shared aliases are ambiguous; do not invent which model was requested.
      if (
        !matches.some(
          (alias) =>
            catalogue.filter((other) => aliases(other).includes(alias))
              .length === 1,
        )
      )
        continue;
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
