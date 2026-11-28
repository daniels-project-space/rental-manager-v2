/** Owner-confirmed capabilities for exact physical lens identities. */
export const REVIEWED_LENS_CAPABILITIES = [
  {
    name: "Sony 28-70mm",
    focus_mode: "autofocus",
    source: "owner-confirmed",
  },
] as const;

export function reviewedLensCapabilities(name: string) {
  return REVIEWED_LENS_CAPABILITIES.find(row => row.name === name) ?? null;
}
