// Generate per-account Aputure notification icons (recoloured) + a monochrome
// badge, rasterised to PNG via sharp. Output → public/icons/.
// Also writes the PWA app icon (public/app-icon.svg + PNGs) as the blue Aputure
// so iOS — which shows the installed app icon on push notifications, not the
// per-notification icon — still surfaces the Aputure mark.
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(process.cwd(), "public");
const OUT = join(PUBLIC, "icons");
mkdirSync(OUT, { recursive: true });

// Base Aputure mark (the dbcinemarentals.com tab icon): aperture iris + record
// dot on a dark rounded square. `ring`/`blade` are the two recoloured strokes.
const mark = (ring, blade) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#060608"/>
  <circle cx="32" cy="32" r="22" fill="none" stroke="${ring}" stroke-width="3"/>
  <g stroke="${blade}" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M49 32l-13.2 5.4"/>
    <path d="M40.5 46.7l-11.2-8.9"/>
    <path d="M23.5 46.7l2-14.2"/>
    <path d="M15 32l13.2-5.4"/>
    <path d="M23.5 17.3l11.2 8.9"/>
    <path d="M40.5 17.3l-2 14.2"/>
  </g>
  <circle cx="51" cy="13" r="4" fill="#f43f5e"/>
</svg>`;

// Monochrome badge (status-bar): white aperture on transparent, OS will tint.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="22" fill="none" stroke="#ffffff" stroke-width="4"/>
  <g stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" fill="none">
    <path d="M49 32l-13.2 5.4"/>
    <path d="M40.5 46.7l-11.2-8.9"/>
    <path d="M23.5 46.7l2-14.2"/>
    <path d="M15 32l13.2-5.4"/>
    <path d="M23.5 17.3l11.2 8.9"/>
    <path d="M40.5 17.3l-2 14.2"/>
  </g>
</svg>`;

// ring + lighter blade per account accent.
const variants = {
  "notif-aputure": ["#38bdf8", "#7dd3fc"], // dbcinema — original blue (default)
  "notif-aputure-leo": ["#a855f7", "#c084fc"], // purple
  "notif-aputure-diogo": ["#f97316", "#fb923c"], // orange
  "notif-aputure-dbcinema_web": ["#10b981", "#34d399"], // emerald
};

const SIZE = 192;
let n = 0;
for (const [name, [ring, blade]] of Object.entries(variants)) {
  await sharp(Buffer.from(mark(ring, blade)))
    .resize(SIZE, SIZE)
    .png()
    .toFile(join(OUT, `${name}.png`));
  n++;
}
await sharp(Buffer.from(badge))
  .resize(SIZE, SIZE)
  .png()
  .toFile(join(OUT, "notif-badge.png"));
n++;

// PWA app icon = blue Aputure (default). SVG for the manifest + PNGs for iOS
// apple-touch-icon / Android.
const appSvg = mark("#38bdf8", "#7dd3fc");
writeFileSync(join(PUBLIC, "app-icon.svg"), appSvg);
for (const px of [180, 192, 512]) {
  await sharp(Buffer.from(appSvg))
    .resize(px, px)
    .png()
    .toFile(join(PUBLIC, `app-icon-${px}.png`));
  n++;
}
console.log(`wrote ${n} icons (notif + app) to ${PUBLIC}`);
