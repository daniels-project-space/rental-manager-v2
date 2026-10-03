/** Original REMUS 1.5X table reviewed on 2026-10-03.
 * Model specifications do not prove supplied flare, kit contents or adaptation. */
export const REVIEWED_REMUS_SPECS = [
  {name: "Anamorphic Blazar Remus 33mm", model: "Blazar Remus 33mm T1.8 1.5X", aperture: "T1.8", closeFocus: "0.49m", plWeight: "880g"},
  {name: "Anamorphic Blazar Remus 45mm", model: "Blazar Remus 45mm T2.0 1.5X", aperture: "T2.0", closeFocus: "0.68m", plWeight: "720g"},
  {name: "Anamorphic Blazar Remus 65mm", model: "Blazar Remus 65mm T2.0 1.5X", aperture: "T2.0", closeFocus: "0.69m", plWeight: "782g"},
  {name: "Anamorphic Blazar Remus 100mm", model: "Blazar Remus 100mm T2.8 1.5X", aperture: "T2.8", closeFocus: "0.71m", plWeight: "788g"},
] as const;
export const REMUS_SPEC_SOURCE = "https://blazarlens.com/remus/";
export function reviewedRemusDescription(facts: typeof REVIEWED_REMUS_SPECS[number]) {
  return `${facts.model}: original Remus-series anamorphic lens; 1.5x squeeze. Maximum aperture ${facts.aperture}, close focus ${facts.closeFocus}, PL-version weight ${facts.plWeight}. Manufacturer image coverage 36x24mm; 16 iris blades; 77mm filter thread; 150-degree focus rotation. These are model specifications, not proof of supplied flare colour, accessories or compatibility with a particular adapter. Remus II and Remus-M are separate variants.`;
}
