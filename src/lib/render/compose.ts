/**
 * Listing-image compositor (sharp + opentype.js) — cloud port of the VPS
 * `run_proof_v4.composite_on_plate` + `batch_render_leo.add_title`.
 *
 * Pipeline: brand plate → soft grounding drop-shadow (from the cutout alpha) →
 * cutout (centred below a reserved top band) → house header (solid-black blocky
 * squared-corner rectangle with centred white ALL-CAPS text).
 *
 * Header text is rendered as VECTOR PATHS via opentype.js, so it needs no fonts
 * installed in the runtime (Vercel / Trigger) — only the font FILE, fetched from
 * R2. Geometry is the pixel-measured Leo treatment (LEO_* constants), font-
 * agnostic via the font's own cap-height ratio.
 */
import sharp from "sharp";
// Namespace import (not default): opentype.js v2 ships an ESM build with only
// named exports. A default import typechecks under esModuleInterop but breaks
// the Turbopack production build ("Export default doesn't exist") — which was
// silently failing every Vercel deploy. `* as` resolves the same members
// (parse / Path / Font) under both tsc and the bundler.
import * as opentype from "opentype.js";
import { getAsset } from "./assets";
import { getBrand, deriveTitle, type BrandConfig } from "./brand";
import { stripBakedTopTitle } from "./strip";

// ── composite_on_plate constants ────────────────────────────────────────────
const BAND_FRAC = 0.16; // reserved top title band, * H
const MARGIN = 0.08; // padding fraction (of shorter edge) around the cutout
const SHADOW_OFFSET = { x: 12, y: 18 };
const SHADOW_BLUR = 16; // gaussian sigma
const SHADOW_OPACITY = 165; // max alpha 0-255

// ── add_title (Leo blocky header) constants ──────────────────────────────────
const LEO_TOP_MARGIN_F = 0.05;
const LEO_BLOCK_HEIGHT_F = 0.125;
const LEO_BLOCK_WIDTH_F = 0.935;
const LEO_CORNER_F = 0.006;
const LEO_SIDE_PAD_F = 0.008;
const LEO_CAP_OF_BLOCK_F = 0.72;
const LEO_TRACK_F = -0.02;
const LEO_MIN_BLOCK_W_F = 0.55;

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function capRatioOf(font: opentype.Font, fallback: number): number {
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  if (os2?.sCapHeight) {
    const r = os2.sCapHeight / font.unitsPerEm;
    if (r > 0.4 && r < 1.2) return r;
  }
  try {
    const bb = font.charToGlyph("H").getBoundingBox();
    const r = (bb.y2 - bb.y1) / font.unitsPerEm;
    if (r > 0.4 && r < 1.2) return r;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** Build the tracked text path at a given font size; returns path + ink bbox. */
function layout(font: opentype.Font, title: string, px: number, track: number) {
  const scale = px / font.unitsPerEm;
  const full = new opentype.Path();
  let x = 0;
  for (const ch of title) {
    const glyph = font.charToGlyph(ch);
    full.extend(glyph.getPath(x, 0, px));
    x += (glyph.advanceWidth ?? 0) * scale + track;
  }
  const bb = full.getBoundingBox(); // {x1,y1,x2,y2}
  return { full, tw: bb.x2 - bb.x1, th: bb.y2 - bb.y1, bb };
}

/**
 * Render the header SVG overlay (transparent W×H with the black block + white
 * vector text). Ports `add_title`'s auto-fit + cap-height block sizing.
 */
function buildHeaderSvg(
  W: number,
  H: number,
  rawTitle: string,
  font: opentype.Font,
  capRatio: number,
  blockHex: string,
  fillHex: string,
): string {
  const title = (rawTitle || "").toUpperCase();
  const baseBlockH = Math.round(H * LEO_BLOCK_HEIGHT_F);
  const radius = Math.max(2, Math.round(W * LEO_CORNER_F));
  const sidePad = Math.round(W * LEO_SIDE_PAD_F);
  const targetCap = Math.round(baseBlockH * LEO_CAP_OF_BLOCK_F);
  const maxBlockW = Math.round(W * LEO_BLOCK_WIDTH_F);
  const maxTextW = maxBlockW - 2 * sidePad;

  // Fit: grow toward target cap, shrink until ink width fits the block.
  let px = Math.max(8, Math.round(targetCap / capRatio));
  let track = LEO_TRACK_F * (px * capRatio);
  let l = layout(font, title, px, track);
  while (px > 8 && l.tw > maxTextW) {
    px -= 2;
    track = LEO_TRACK_F * (px * capRatio);
    l = layout(font, title, px, track);
  }

  const actualCap = Math.round(px * capRatio);
  let blockH = Math.round(actualCap / LEO_CAP_OF_BLOCK_F);
  blockH = Math.max(blockH, Math.round(H * 0.07));
  let blockW = l.tw + 2 * sidePad;
  blockW = Math.min(blockW, maxBlockW);
  blockW = Math.max(blockW, Math.round(W * LEO_MIN_BLOCK_W_F));

  const bx0 = Math.floor((W - blockW) / 2);
  const by0 = Math.round(H * LEO_TOP_MARGIN_F);

  // Centre the ink bbox inside the block.
  const dx = bx0 + (blockW - l.tw) / 2 - l.bb.x1;
  const dy = by0 + (blockH - l.th) / 2 - l.bb.y1;
  const pathData = l.full.toPathData(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect x="${bx0}" y="${by0}" width="${blockW}" height="${blockH}" rx="${radius}" ry="${radius}" fill="#${blockHex}"/>
  <g transform="translate(${dx},${dy})"><path d="${pathData}" fill="#${fillHex}"/></g>
</svg>`;
}

/** Crop a sprite to the canvas-visible region so sharp.composite never errors. */
async function clampSprite(
  buf: Buffer,
  sw: number,
  sh: number,
  left: number,
  top: number,
  W: number,
  H: number,
): Promise<{ input: Buffer; left: number; top: number } | null> {
  let cropLeft = 0;
  let cropTop = 0;
  let cropW = sw;
  let cropH = sh;
  if (left < 0) {
    cropLeft = -left;
    cropW = sw + left;
    left = 0;
  }
  if (top < 0) {
    cropTop = -top;
    cropH = sh + top;
    top = 0;
  }
  if (left + cropW > W) cropW = W - left;
  if (top + cropH > H) cropH = H - top;
  if (cropW <= 0 || cropH <= 0) return null;
  let out = buf;
  if (cropLeft || cropTop || cropW !== sw || cropH !== sh) {
    out = await sharp(buf)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .toBuffer();
  }
  return { input: out, left, top };
}

/** Load + size the brand plate; returns an RGBA PNG buffer + its dimensions. */
async function loadPlate(brand: BrandConfig): Promise<{ buf: Buffer; W: number; H: number }> {
  if (brand.plate.mode === "solid") {
    const { w, h, hex } = brand.plate;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const buf = await sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } })
      .png()
      .toBuffer();
    return { buf, W: w, H: h };
  }
  const raw = await getAsset(brand.plate.key);
  const img = sharp(raw).ensureAlpha();
  const meta = await img.metadata();
  const W = meta.width!;
  const H = meta.height!;
  const buf = await img.png().toBuffer();
  return { buf, W, H };
}

/**
 * Compose a finished branded listing image from a transparent-bg cutout PNG.
 * Returns PNG bytes.
 */
export async function composeListingImage(args: {
  account: string;
  cutoutPng: Buffer;
  title: string;
}): Promise<Buffer> {
  const brand = getBrand(args.account);
  const { buf: plateBuf, W, H } = await loadPlate(brand);

  // Remove any baked top title bar, then trim to the content bbox (matches the
  // Python strip_baked_top_title + alpha-bbox crop).
  const stripped = await stripBakedTopTitle(args.cutoutPng);
  const trimmed = await sharp(stripped).ensureAlpha().trim().toBuffer();
  const tMeta = await sharp(trimmed).metadata();
  const cw = tMeta.width!;
  const ch = tMeta.height!;

  // composite_on_plate framing.
  const short = Math.min(W, H);
  const pad = MARGIN * short;
  const bandH = Math.round(H * BAND_FRAC);
  const regionTop = bandH + pad * 0.4;
  const regionBottom = H - pad;
  const availW = W - 2 * pad;
  const availH = regionBottom - regionTop;
  const scale = Math.min(availW / cw, availH / ch);
  const newW = Math.max(1, Math.round(cw * scale));
  const newH = Math.max(1, Math.round(ch * scale));
  const ox = Math.round((W - newW) / 2);
  const oy = Math.round(regionTop + (availH - newH) / 2);

  const scaledBuf = await sharp(trimmed).resize(newW, newH, { kernel: "lanczos3" }).png().toBuffer();

  // Soft drop shadow: black silhouette from the cutout alpha, scaled by opacity,
  // padded, gaussian-blurred, offset down-right.
  const { data: alpha } = await sharp(scaledBuf)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const silAlpha = Buffer.alloc(alpha.length);
  for (let i = 0; i < alpha.length; i++) silAlpha[i] = Math.round((alpha[i] * SHADOW_OPACITY) / 255);
  const bpad = SHADOW_BLUR * 3;
  const shadowBuf = await sharp({ create: { width: newW, height: newH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(silAlpha, { raw: { width: newW, height: newH, channels: 1 } })
    .extend({ top: bpad, bottom: bpad, left: bpad, right: bpad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(SHADOW_BLUR)
    .png()
    .toBuffer();
  const shadowSprite = await clampSprite(
    shadowBuf,
    newW + 2 * bpad,
    newH + 2 * bpad,
    ox - bpad + SHADOW_OFFSET.x,
    oy - bpad + SHADOW_OFFSET.y,
    W,
    H,
  );

  // Header overlay.
  const font = opentype.parse(toArrayBuffer(await getAsset(brand.fontKey)));
  const capRatio = capRatioOf(font, brand.capFallback);
  const svg = buildHeaderSvg(W, H, deriveTitle(args.title), font, capRatio, brand.headerBlock, brand.headerFill);

  const cutoutSprite = await clampSprite(scaledBuf, newW, newH, ox, oy, W, H);

  const layers: sharp.OverlayOptions[] = [];
  if (shadowSprite) layers.push(shadowSprite);
  if (cutoutSprite) layers.push(cutoutSprite);
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });

  return sharp(plateBuf).composite(layers).png().toBuffer();
}

/**
 * End-to-end render of one listing image from a SOURCE photo URL: cutout (fal)
 * → compose. Returns PNG bytes. (Cutout import kept here so callers do one call.)
 */
export async function renderFromSource(args: {
  account: string;
  sourceImageUrl: string;
  title: string;
}): Promise<Buffer> {
  const { cutout } = await import("./cutout");
  const cutoutPng = await cutout(args.sourceImageUrl);
  return composeListingImage({ account: args.account, cutoutPng, title: args.title });
}
