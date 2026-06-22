/**
 * Baked top-title-bar removal — cloud port of the VPS
 * `batch_render_leo.strip_baked_top_title` / `_detect_baked_bar`.
 *
 * Some source photos (DB Cinema / fat-llama promos) carry a burned-in title
 * banner across the TOP of the image — a printed near-full-width black bar with
 * white glyphs (e.g. "6K PRO CAMERA"). BiRefNet keeps it (it's foreground), so
 * without removal it doubles with our own header. This zeroes the alpha of that
 * band, then re-crops to the content bbox. Strict NO-OP on clean cutouts.
 *
 * Content-based signature (alpha-independent), per row in the top 40%:
 *   flat_black : printed solid fill — mean luma < 22 AND mean per-channel
 *                std-dev < 12 (a photographed black object keeps high variance).
 *   bar_text   : white-text-on-black — mostly dark with a slug of bright pixels
 *                and few mid-tones.
 * The bar = a contiguous band of such rows beginning in the top 12%, carrying
 * BOTH a flat_black and a bar_text row, 6+ rows tall, 1.2%–40% of height.
 *
 * NB: the VPS additionally clamped the erase to the top of the largest opaque
 * component (a connected-component pass) to protect tall gear that touches the
 * bar (e.g. a drone's propellers). That clamp is omitted here — the band walk
 * already stops at the first product rows, so the erase stays tightly bounded.
 */
import sharp from "sharp";

const SPAN_MIN = 0.75;
const TOP_FRAC = 0.12;
const GAP_TOL = 4;
const LOOKAHEAD_FRAC = 0.06;

interface RowClass {
  flatBlack: boolean[];
  barText: boolean[];
  isBar: boolean[];
  productRow: boolean[];
}

function classifyRows(
  data: Buffer,
  w: number,
  limit: number,
  x0: number,
  x1: number,
): RowClass {
  const contentW = Math.max(1, x1 - x0 + 1);
  const flatBlack = new Array<boolean>(limit).fill(false);
  const barText = new Array<boolean>(limit).fill(false);
  const isBar = new Array<boolean>(limit).fill(false);
  const productRow = new Array<boolean>(limit).fill(false);

  for (let y = 0; y < limit; y++) {
    let opaque = 0;
    let minc = w;
    let maxc = -1;
    let sumL = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumR2 = 0;
    let sumG2 = 0;
    let sumB2 = 0;
    let dark = 0;
    let mid = 0;
    let bright = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] <= 40) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      opaque++;
      if (x < minc) minc = x;
      if (x > maxc) maxc = x;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumL += lum;
      sumR += r; sumG += g; sumB += b;
      sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      if (lum < 60) dark++;
      else if (lum <= 170) mid++;
      else bright++;
    }
    const wideEnough = opaque >= 0.45 * contentW;
    if (!wideEnough) continue;
    productRow[y] = true; // full-width row (may be reclassified as bar below)
    const span = (maxc - minc + 1) / contentW;
    if (span < SPAN_MIN) continue;

    const n = opaque;
    const meanL = sumL / n;
    const varR = sumR2 / n - (sumR / n) ** 2;
    const varG = sumG2 / n - (sumG / n) ** 2;
    const varB = sumB2 / n - (sumB / n) ** 2;
    const chanStd = (Math.sqrt(Math.max(0, varR)) + Math.sqrt(Math.max(0, varG)) + Math.sqrt(Math.max(0, varB))) / 3;
    const darkFrac = dark / n;
    const midFrac = mid / n;
    const brightFrac = bright / n;

    flatBlack[y] = meanL < 22 && chanStd < 12;
    barText[y] =
      (darkFrac >= 0.3 && brightFrac >= 0.05 && midFrac < 0.5) ||
      (darkFrac >= 0.8 && midFrac < 0.2);
    isBar[y] = flatBlack[y] || barText[y];
    if (isBar[y]) productRow[y] = false; // a bar row is not a "product" gap row
  }
  return { flatBlack, barText, isBar, productRow };
}

function detectEraseHeight(data: Buffer, w: number, h: number): number {
  // content x-range
  let x0 = w;
  let x1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  if (x1 < 0) return 0;

  const limit = Math.floor(h * 0.4);
  const { flatBlack, barText, isBar, productRow } = classifyRows(data, w, limit, x0, x1);

  let top = -1;
  for (let y = 0; y < limit; y++) {
    if (isBar[y]) { top = y; break; }
  }
  if (top < 0 || top > h * TOP_FRAC) return 0;

  const walk = (start: number): number => {
    let y = start;
    let prodStreak = 0;
    let lastBar = start;
    while (y < limit) {
      if (isBar[y]) {
        lastBar = y;
        prodStreak = 0;
      } else if (productRow[y]) {
        prodStreak++;
        if (prodStreak >= GAP_TOL) break;
      }
      y++;
    }
    return lastBar + 1;
  };

  let end = walk(top);

  for (let k = 0; k < 4; k++) {
    let nxt = -1;
    const lookEnd = Math.min(end + Math.floor(h * LOOKAHEAD_FRAC), limit);
    for (let y = end; y < lookEnd; y++) {
      if (isBar[y]) { nxt = y; break; }
    }
    if (nxt < 0) break;
    const segEnd = walk(nxt);
    let hasFB = false;
    let hasBT = false;
    for (let y = nxt; y < segEnd; y++) {
      if (flatBlack[y]) hasFB = true;
      if (barText[y]) hasBT = true;
    }
    if (hasFB && hasBT && segEnd - nxt >= 6) end = segEnd;
    else break;
  }

  let anyFB = false;
  let anyBT = false;
  for (let y = top; y < end; y++) {
    if (flatBlack[y]) anyFB = true;
    if (barText[y]) anyBT = true;
  }
  if (!anyFB || !anyBT) return 0;
  if (end - top < 6) return 0;
  const frac = (end - top) / h;
  if (frac < 0.012 || frac >= 0.4) return 0;

  return Math.min(end + 2, h);
}

/** Remove a baked top title bar from a transparent-bg cutout PNG (no-op if none). */
export async function stripBakedTopTitle(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const buf = Buffer.from(data);
  const erase = detectEraseHeight(buf, w, h);
  if (erase <= 0) return png; // strict no-op

  for (let y = 0; y < erase; y++) {
    for (let x = 0; x < w; x++) {
      buf[(y * w + x) * 4 + 3] = 0;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().trim().toBuffer();
}
