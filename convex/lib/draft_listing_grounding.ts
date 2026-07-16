export function exactListingProductIds(
  lines: Array<{ product_id?: number | null; product_id_exact: boolean }>,
): number[] {
  return [
    ...new Set(
      lines
        .filter((line) => line.product_id_exact)
        .map((line) => line.product_id)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
}
