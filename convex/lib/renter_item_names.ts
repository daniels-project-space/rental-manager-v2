import { shortItemName } from "./item_display_name";

/** Presentation aliases of an established item identity. Expand only complete
 * known model names; advertising titles and comparison models stay literal. */
export function renterItemNames(name: string): string[] {
  const names = [name, shortItemName(name)];
  const bm = /^(?:BMPCC|Blackmagic(?:\s+Pocket\s+Cinema\s+Camera|\s+Cinema\s+Camera)?)\s+6K\s+(Pro|Full\s+Frame|FF)$/i.exec(name.trim());
  if (bm) {
    const variant = /^pro$/i.test(bm[1]) ? "Pro" : "Full Frame";
    for (const prefix of ["BMPCC", "Blackmagic", "Blackmagic Pocket Cinema Camera", "Blackmagic Cinema Camera"])
      names.push(`${prefix} 6K ${variant}`);
    if (variant === "Full Frame") names.push("BMPCC 6K FF", "Blackmagic 6K FF");
  }
  return [...new Set(names.filter(Boolean))];
}
