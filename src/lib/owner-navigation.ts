/** Authentication must never turn a notification's return link into an external redirect. */
export function ownerReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://rental-manager.invalid");
    if (url.origin !== "https://rental-manager.invalid" || /^\/login(?:\/|$)/.test(url.pathname)) return "/";
    return url.pathname + url.search + url.hash;
  } catch { return "/"; }
}

export function ownerLoginHref(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(ownerReturnTo(returnTo))}`;
}
