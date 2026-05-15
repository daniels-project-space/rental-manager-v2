#!/usr/bin/env node
/**
 * Dashboard widget screenshot harness — Pass 1 baseline capture.
 *
 * Documents what was done in the Phase 2 audit run on 2026-05-15.
 * Re-runnable with `node widget-screenshots.mjs` (requires `playwright` installed).
 *
 *   npm i -D playwright
 *   npx playwright install chromium
 *   node scripts/audit/widget-screenshots.mjs
 *
 * Output: /tmp/rm-v2-audit/pass-1/*.png + *-tiles.json
 *
 * Discovered facts about the dashboard (no auth required, public Vercel URL):
 *  - Dashboard at https://rental-manager-v2-nu.vercel.app/ — NO login wall.
 *  - Stat cards rendered as <button> with accessible name "ACTIVE RENTALS 17 …".
 *  - In-place ActiveRentals "drawer" container = `.stat-card-drawer` (one per stat
 *    card; only the open one has content). Click stat-card to toggle.
 *  - CalendarStrip = horizontal day-rail of <button>s whose text starts with
 *    MON/TUE/.../SUN. NO <img> tiles in compact mode (text-only).
 *  - WeeklyCalendar = expanded 7-day grid revealed by clicking "📅 Weekly View"
 *    toggle. Renders ~64 hygglo.imgix.net tiles per item per day.
 *  - CalendarGantt = full-screen modal at `.gantt-backdrop` triggered by
 *    clicking a day cell with rentals. Renders rental tiles as horizontal bars.
 *  - LiveActivity, ReturnHub render NO <img> tags (text/list only).
 *  - CriticalAlerts heading NOT present on home dashboard at this time
 *    (component exists in src/ but conditionally rendered, e.g. zero alerts).
 *  - All rental tile images are served from hygglo.imgix.net.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const URL = 'https://rental-manager-v2-nu.vercel.app';
const OUT = '/tmp/rm-v2-audit/pass-1';

async function probeImgsIn(page, selector) {
  return page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return { error: 'no root', selector: sel };
    const imgs = Array.from(root.querySelectorAll('img')).map((i) => ({
      src: i.src,
      alt: i.alt,
      naturalW: i.naturalWidth,
      naturalH: i.naturalHeight,
      parentText: (i.closest('[data-rental],[data-reservation],[data-rental-id],li,div')?.innerText || '').slice(0, 200),
    }));
    return { count: imgs.length, tiles: imgs };
  }, selector);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: 'networkidle' });

  // 0. Full dashboard baseline
  await page.screenshot({ path: path.join(OUT, '00-dashboard-full.png'), fullPage: true });

  // 4. Open ActiveDrawer by clicking the Active Rentals stat card
  await page.getByRole('button', { name: /Active Rentals \d+/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '04-active-drawer.png'), fullPage: false });
  // ActiveDrawer is rendered as a `.stat-card-drawer` div sibling of the stat
  // card. Each stat card has its OWN .stat-card-drawer in the DOM, but only
  // the open one has rendered content — so #_r_0_ (the first) tracks the
  // ActiveRentals drawer.
  await page.locator('#_r_0_').screenshot({ path: path.join(OUT, '04-active-drawer-element.png') });
  const drawerTiles = await probeImgsIn(page, '.stat-card-drawer');
  await writeFile(path.join(OUT, 'active-drawer-tiles.json'), JSON.stringify(drawerTiles, null, 2));

  // close drawer
  await page.getByRole('button', { name: /Active Rentals \d+/ }).click();
  await page.waitForTimeout(200);

  // 2. CalendarStrip (compact day-rail in place)
  await page.evaluate(() => window.scrollTo(0, 1900));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '02-calendar-strip.png'), fullPage: false });
  const stripTiles = await page.evaluate(() => {
    const dayBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
      /^(MON|TUE|WED|THU|FRI|SAT|SUN)\b/.test(b.innerText || '')
    );
    let strip = dayBtns[0];
    for (let i = 0; i < 8; i++) {
      if (!strip) break;
      strip = strip.parentElement;
      if (strip && dayBtns.every((b) => strip.contains(b))) break;
    }
    const imgs = strip ? Array.from(strip.querySelectorAll('img')).map((i) => ({ src: i.src, alt: i.alt })) : [];
    return { stripFound: !!strip, dayCount: dayBtns.length, imgCount: imgs.length, tiles: imgs };
  });
  await writeFile(path.join(OUT, 'calendar-strip-tiles.json'), JSON.stringify(stripTiles, null, 2));

  // 3. WeeklyCalendar (toggle via "📅 Weekly View" button)
  await page.getByRole('button', { name: /Weekly View/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '03-weekly-calendar.png'), fullPage: false });
  await page.screenshot({ path: path.join(OUT, '00-dashboard-full-weekly.png'), fullPage: true });
  const weeklyTiles = await page.evaluate(() => {
    const dayBtns = Array.from(document.querySelectorAll('button')).filter((b) =>
      /^(MON|TUE|WED|THU|FRI|SAT|SUN)\b/.test(b.innerText || '')
    );
    let container = dayBtns[0];
    for (let i = 0; i < 10; i++) {
      if (!container) break;
      container = container.parentElement;
      if (container && dayBtns.every((b) => container.contains(b))) break;
    }
    const imgs = container
      ? Array.from(container.querySelectorAll('img')).map((i) => ({
          src: i.src,
          alt: i.alt,
          parentText: (i.closest('div,li')?.innerText || '').slice(0, 150),
        }))
      : [];
    return { imgCount: imgs.length, tiles: imgs };
  });
  await writeFile(path.join(OUT, 'weekly-calendar-tiles.json'), JSON.stringify(weeklyTiles, null, 2));

  // 1. CalendarGantt — opens as full-screen modal when clicking a day cell.
  // Click any day with rentals (e.g. SAT 16 with 5 rentals).
  await page.locator('button').filter({ hasText: /^(MON|TUE|WED|THU|FRI|SAT|SUN)/ }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '01-calendar-gantt.png'), fullPage: false });
  await page.locator('.gantt-backdrop').screenshot({ path: path.join(OUT, '01-calendar-gantt-element.png') });
  const ganttTiles = await probeImgsIn(page, '.gantt-backdrop');
  await writeFile(path.join(OUT, 'calendar-gantt-tiles.json'), JSON.stringify(ganttTiles, null, 2));
  await page.keyboard.press('Escape');

  // 5. LiveActivity (in-place section, no images expected)
  await page.evaluate(() => window.scrollTo(0, 1450));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '05-live-activity.png'), fullPage: false });

  // 6. ReturnHub (in-place section, no images expected)
  await page.evaluate(() => window.scrollTo(0, 2150));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '06-return-hub.png'), fullPage: false });

  // 7. CriticalAlerts: NOT rendered on home page when zero alerts are active.
  // Component file: src/components/dashboard/CriticalAlerts.tsx — confirm
  // conditional rendering. Captured here as a blocker note (see phase2 md).

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
