/**
 * Per-account brand profiles for the listing-image renderer.
 *
 * Mirrors the VPS `brands/<acct>.json` files (leo.json / diogo.json):
 *   - leo   : pastel multi-tone IMAGE plate + Bebas Neue Bold header.
 *   - diogo : solid #D2D2D2 plate (1600×1193) + Archivo Black header.
 * Both use the house header: solid-black blocky squared-corner rectangle with
 * centered white ALL-CAPS text. `capFallback` is the measured cap-height ratio
 * for the font (used only if it can't be read from the font's OS/2 table).
 */
export interface PlateImage {
  mode: "image";
  /** R2 key of the plate JPG. */
  key: string;
}
export interface PlateSolid {
  mode: "solid";
  hex: string;
  w: number;
  h: number;
}
export interface BrandConfig {
  account: string;
  plate: PlateImage | PlateSolid;
  /** R2 key of the header font (otf/ttf). */
  fontKey: string;
  /** Header block colour (hex, no #). */
  headerBlock: string;
  /** Header text colour (hex, no #). */
  headerFill: string;
  /** Measured cap-height ratio fallback for the font. */
  capFallback: number;
}

export const BRANDS: Record<string, BrandConfig> = {
  leo: {
    account: "leo",
    plate: { mode: "image", key: "assets/render/plates/leo.jpg" },
    fontKey: "assets/render/fonts/BebasNeue-Bold.otf",
    headerBlock: "000000",
    headerFill: "FFFFFF",
    capFallback: 0.7,
  },
  diogo: {
    account: "diogo",
    plate: { mode: "solid", hex: "D2D2D2", w: 1600, h: 1193 },
    fontKey: "assets/render/fonts/ArchivoBlack-Regular.ttf",
    headerBlock: "000000",
    headerFill: "FFFFFF",
    capFallback: 0.69,
  },
};

export function getBrand(account: string): BrandConfig {
  const b = BRANDS[account];
  if (!b) throw new Error(`no render brand for account '${account}' (have: ${Object.keys(BRANDS).join(", ")})`);
  return b;
}

const TITLE_MAX_LEN = 34;

/**
 * Derive the header title from a product name (ported from the VPS
 * `derive_title`): uppercase, strip DB-CINEMA tokens + brackets, collapse
 * whitespace, cap absurdly long names at a word boundary, trim connectors.
 */
export function deriveTitle(name: string): string {
  let t = (name || "").toUpperCase();
  t = t.replace(/DB[\s-]?CINEMA/g, " ").replace(/DBCINEMA/g, " ");
  t = t.replace(/[()[\]]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > TITLE_MAX_LEN) {
    const cut = t.slice(0, TITLE_MAX_LEN);
    const sp = cut.lastIndexOf(" ");
    t = (sp > 14 ? cut.slice(0, sp) : cut).trim();
  }
  t = t.replace(/[\s|+\-/,&]+$/, "").replace(/^[\s|+\-/,&]+/, "").trim();
  return t || (name || "ITEM").toUpperCase().slice(0, TITLE_MAX_LEN).trim();
}
