/** Exact physical lens identities supplied by the owner and cross-checked against manufacturer specifications. */
export const REVIEWED_LENS_MOUNTS = [
  {
    name: "Sony 28-70mm",
    model: "Sony FE 28-70mm F3.5-5.6 OSS (SEL2870)",
    mount: "Sony E-mount",
    coverage: "full_frame",
    identity_source: "owner-confirmed exact model",
    source_url: "https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/sel2870/specifications",
  },
] as const;

export function reviewedLensMount(name: string) {
  return REVIEWED_LENS_MOUNTS.find(row => row.name === name) ?? null;
}
