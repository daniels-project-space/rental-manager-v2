export function componentReplacementInventoryFingerprint(items: any[]): string {
  return JSON.stringify(items.map(item => [String(item._id), item.status, item.is_marketing_only, item.qty, item.replacement_cost_gbp])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function missingComponentMatchesSellerCopy(missing: {source_url:string;source_excerpt:string}, listing: {public_url?:string;description?:string} | null | undefined): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-GB");
  return !!listing?.public_url && listing.public_url === missing.source_url && !!listing.description &&
    normalize(missing.source_excerpt).length >= 10 && normalize(listing.description).includes(normalize(missing.source_excerpt));
}
