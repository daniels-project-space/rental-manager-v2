/** Accept actual provider portraits only; reject unsafe URLs. */
export function profileImageUrl(value: unknown): string | undefined {
  const image =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? [
            "fullSizeUrl",
            "large",
            "originalUrl",
            "url",
            "medium",
            "thumbnailUrl",
          ]
            .map((key) => (value as Record<string, unknown>)[key])
            .find((v) => typeof v === "string")
        : undefined;
  if (typeof image !== "string") return undefined;
  try {
    const url = new URL(image);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
