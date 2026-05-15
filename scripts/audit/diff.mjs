#!/usr/bin/env node
// Phase 4: Mismatch diff between Hygglo ground-truth, Convex state, and widget tiles.
// Outputs:
//   /tmp/rm-v2-audit/MISMATCH-pass-1.md
//   /tmp/rm-v2-audit/MISMATCH-pass-1.json

import fs from 'node:fs';

const GT_PATH    = '/tmp/rm-v2-audit/ground-truth.json';
const CV_PATH    = '/tmp/rm-v2-audit/convex-state.json';
const TILE_DIR   = '/tmp/rm-v2-audit/pass-1';
const OUT_MD     = '/tmp/rm-v2-audit/MISMATCH-pass-1.md';
const OUT_JSON   = '/tmp/rm-v2-audit/MISMATCH-pass-1.json';

// ---------- helpers ----------
const norm = (u) => {
  if (!u) return null;
  try {
    const p = new URL(u).pathname;
    return (p.split('/').pop() || '').split('?')[0].toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
};

const safeRead = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
};

// widget JSON files are JSON-encoded strings of objects → double-decode
const readTiles = (p) => {
  if (!fs.existsSync(p)) return { count: 0, tiles: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { count: 0, tiles: [] }; }
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch {}
  }
  if (!raw || !Array.isArray(raw.tiles)) return { count: 0, tiles: [] };
  return raw;
};

const lower = (s) => (s || '').toString().toLowerCase();

// item-name → tokens for fuzzy match against alt
const tokens = (s) => lower(s).split(/[^a-z0-9]+/).filter(t => t.length >= 4);

// Does tile alt text or parentText reference this order? Use renter name OR item-name token match.
function tileMatchesOrder(tile, order) {
  const alt = lower(tile.alt);
  const pt  = lower(tile.parentText);
  const renter = lower(order.renter_name).trim();
  if (renter && renter.length >= 4 && pt.includes(renter)) return { reason: 'renter-name', conf: 'high' };

  // item name token-overlap on alt
  for (const it of order.items) {
    const itLower = lower(it.name);
    // require ≥ 3 distinct tokens of length≥4 overlap, OR a long substring
    const toks = tokens(it.name);
    if (toks.length === 0) continue;
    // Strong: alt is a substring of item name or vice versa (Hygglo title often equals item name)
    if (alt && (alt.length >= 10) && (itLower.includes(alt) || alt.includes(itLower.slice(0, Math.min(60, itLower.length))))) {
      return { reason: 'name-substring', conf: 'high', item: it.name };
    }
    // Fallback: 3+ token overlap
    const altToks = new Set(tokens(alt));
    let overlap = 0;
    for (const t of toks) if (altToks.has(t)) overlap++;
    if (overlap >= 3) return { reason: 'token-overlap', conf: 'med', item: it.name, overlap };
  }
  return null;
}

// ---------- load ----------
const gt = safeRead(GT_PATH);
const cv = safeRead(CV_PATH);
if (!gt || !cv) { console.error('Failed to load inputs'); process.exit(2); }

const orders = gt.orders || [];
const reservations = cv.reservations || [];
const items = cv.items || [];

// Convex items map for image lookup by item name (case-insensitive trim) AND by _id
const itemByName = new Map();
const itemById   = new Map();
for (const it of items) {
  itemByName.set(lower(it.name).trim(), it);
  if (it.name_input) itemByName.set(lower(it.name_input).trim(), it);
  if (it._id) itemById.set(it._id, it);
}

// Reservation map by hygglo_order_id (string)
const resByOrder = new Map();
for (const r of reservations) {
  if (r.hygglo_order_id) resByOrder.set(String(r.hygglo_order_id), r);
}

// Widgets
const adTiles = readTiles(`${TILE_DIR}/active-drawer-tiles.json`).tiles;
const wkTiles = readTiles(`${TILE_DIR}/weekly-calendar-tiles.json`).tiles;
const gaTiles = readTiles(`${TILE_DIR}/calendar-gantt-tiles.json`).tiles;
const stTiles = readTiles(`${TILE_DIR}/calendar-strip-tiles.json`).tiles;

const widgets = [
  { name: 'active-drawer',    tiles: adTiles },
  { name: 'weekly-calendar',  tiles: wkTiles },
  { name: 'calendar-gantt',   tiles: gaTiles },
  { name: 'calendar-strip',   tiles: stTiles },
];

// ---------- per-order analysis ----------
const rows = [];
const buckets = {
  wrong_image: [],
  duplicate_image: [],
  missing_tile: [],
  extra_tile: [],
  unbacked_in_convex: [],
  orphan_convex_no_hygglo: [],
  count_mismatch: [],
  resolver_lag: [],
};

const seenHyggloOrders = new Set();

for (const order of orders) {
  seenHyggloOrders.add(String(order.order_id));
  const res = resByOrder.get(String(order.order_id));

  // Hygglo items (name + first image)
  const hyItems = (order.items || []).map(it => ({
    name: it.name,
    hygglo_img: (it.image_urls && it.image_urls[0]) || null,
    hygglo_basename: norm((it.image_urls && it.image_urls[0]) || null),
  }));

  // Convex resolved items (try resolved_items first; else fall back to items[].item_name lookup)
  let cvResolved = [];
  if (res) {
    if (Array.isArray(res.resolved_items) && res.resolved_items.length > 0) {
      cvResolved = res.resolved_items.map(ri => {
        // resolved_items shape: {confidence, item_id, item_name_canonical}
        const nm = ri.item_name_canonical || ri.name || ri.item_name || '';
        let img = ri.image_url || null;
        let itm = null;
        if (!img && ri.item_id) { itm = itemById.get(ri.item_id); if (itm) img = itm.image_url; }
        if (!img && nm) { itm = itemByName.get(lower(nm).trim()); if (itm) img = itm.image_url; }
        return { name: nm, item_id: ri.item_id || null, convex_img: img, convex_basename: norm(img), source: 'resolved_items', confidence: ri.confidence };
      });
    } else if (Array.isArray(res.items)) {
      cvResolved = res.items.map(ri => {
        const nm = ri.item_name || ri.name || '';
        const itm = itemByName.get(lower(nm).trim());
        const img = itm ? itm.image_url : null;
        return { name: nm, convex_img: img, convex_basename: norm(img), source: 'items-fallback', unresolved: !itm };
      });
    }
  }

  // Find widget tiles that reference this order
  const tilesByWidget = {};
  for (const w of widgets) {
    const matches = [];
    for (const t of w.tiles) {
      const m = tileMatchesOrder(t, order);
      if (m) matches.push({ ...t, _match: m });
    }
    tilesByWidget[w.name] = matches;
  }
  const allWidgetTiles = Object.entries(tilesByWidget).flatMap(([w, ts]) => ts.map(t => ({ widget: w, ...t })));

  // Per-item triple: Hygglo / Convex / Widget
  // Build a per-item correlation. For each Hygglo item, try to find the matching Convex resolved item
  // (best by name substring), then choose the best widget tile (by name substring on alt).
  const perItem = [];
  for (const hi of hyItems) {
    // best convex match by name
    let best = null, bestScore = 0;
    for (const ci of cvResolved) {
      if (!ci.name) continue;
      const a = lower(hi.name), b = lower(ci.name);
      const score = (a.includes(b.slice(0,30)) || b.includes(a.slice(0,30))) ? 1 : 0;
      if (score > bestScore) { best = ci; bestScore = score; }
    }
    // widget tiles whose alt substrings into hi.name (or vice versa)
    const matchedTiles = [];
    for (const wt of allWidgetTiles) {
      const a = lower(wt.alt || '');
      const n = lower(hi.name);
      if (!a) continue;
      if (a.length >= 8 && (n.includes(a) || a.includes(n.slice(0, Math.min(40, n.length))))) {
        matchedTiles.push({ widget: wt.widget, src: wt.src, alt: wt.alt, basename: norm(wt.src) });
      }
    }
    perItem.push({
      hygglo: { name: hi.name, image_url: hi.hygglo_img, basename: hi.hygglo_basename },
      convex: best ? { name: best.name, image_url: best.convex_img, basename: best.convex_basename, source: best.source } : null,
      widget_tiles: matchedTiles,
    });
  }

  // Compute mismatches per item
  const itemDiagnostics = perItem.map(p => {
    const cvOk = p.convex && p.convex.basename && p.hygglo.basename && p.convex.basename === p.hygglo.basename;
    const widgetSet = new Set(p.widget_tiles.map(t => t.basename).filter(Boolean));
    const widgetOk  = widgetSet.size > 0 && widgetSet.has(p.hygglo.basename);
    const widgetWrong = widgetSet.size > 0 && !widgetSet.has(p.hygglo.basename);
    return {
      hygglo_basename: p.hygglo.basename,
      convex_basename: p.convex?.basename || null,
      widget_basenames: [...widgetSet],
      convex_match: !!cvOk,
      convex_missing: !p.convex || !p.convex.basename,
      widget_match: !!widgetOk,
      widget_wrong: !!widgetWrong,
      widget_missing: widgetSet.size === 0,
      _detail: p,
    };
  });

  // Duplicate image inside same rental — check BOTH the resolver's image picks AND photos_urls cache.
  // photos_urls = Convex's cached Hygglo image set; if 2+ slots map to same basename → known dup-image bug.
  const cvBasenames = cvResolved.map(c => c.convex_basename).filter(Boolean);
  const photoBasenames = (res?.photos_urls || []).map(norm).filter(Boolean);
  const dupGroups = {};
  for (const b of cvBasenames)   dupGroups[b] = (dupGroups[b] || 0) + 1;
  const dups = Object.entries(dupGroups).filter(([_, n]) => n >= 2).map(([b]) => b);
  const photoDupGroups = {};
  for (const b of photoBasenames) photoDupGroups[b] = (photoDupGroups[b] || 0) + 1;
  const photoDups = Object.entries(photoDupGroups).filter(([_, n]) => n >= 2).map(([b]) => b);

  const row = {
    order_id: order.order_id,
    account: order.account,
    renter_name: order.renter_name,
    start: order.start, end: order.end,
    hygglo_item_count: hyItems.length,
    convex_resolved_count: cvResolved.length,
    convex_reservation_id: res?._id || null,
    resolver_lag: !!(res && (!res.resolved_items || res.resolved_items.length === 0)),
    items: itemDiagnostics,
    widget_tile_count: allWidgetTiles.length,
    duplicate_image_basenames: dups,
    photos_urls_basenames: photoBasenames,
    photos_urls_duplicate_basenames: photoDups,
  };

  rows.push(row);

  if (!res) {
    buckets.unbacked_in_convex.push({ order_id: order.order_id, account: order.account, renter: order.renter_name });
    continue;
  }
  if (row.resolver_lag) buckets.resolver_lag.push({ order_id: order.order_id, account: order.account, reservation_id: res._id });
  if (row.hygglo_item_count !== row.convex_resolved_count && !row.resolver_lag) {
    buckets.count_mismatch.push({ order_id: order.order_id, hygglo: row.hygglo_item_count, convex: row.convex_resolved_count });
  }
  for (const d of itemDiagnostics) {
    if (d.convex_basename && d.hygglo_basename && d.convex_basename !== d.hygglo_basename) {
      buckets.wrong_image.push({
        order_id: order.order_id, account: order.account, renter: order.renter_name,
        item: d._detail.hygglo.name, hygglo: d.hygglo_basename, convex: d.convex_basename, source: d._detail.convex?.source,
      });
    }
    if (d.widget_wrong) {
      buckets.wrong_image.push({
        order_id: order.order_id, account: order.account, renter: order.renter_name,
        item: d._detail.hygglo.name, hygglo: d.hygglo_basename, widget: d.widget_basenames, surface: 'widget',
      });
    }
  }
  if (dups.length > 0) buckets.duplicate_image.push({ order_id: order.order_id, account: order.account, renter: order.renter_name, source: 'resolved_items', duplicates: dups, items: cvResolved.map(c=>({name:c.name,basename:c.convex_basename})) });
  if (photoDups.length > 0) buckets.duplicate_image.push({ order_id: order.order_id, account: order.account, renter: order.renter_name, source: 'photos_urls', duplicates: photoDups, items: photoBasenames.map(b=>({name:'(photos_urls slot)',basename:b})) });

  // Missing-tile vs extra-tile heuristic:
  // - missing: order is "current/upcoming" (window-overlapping) AND no widget tile references any item or renter
  // - extra : skipped — without exhaustive widget→GT linking we cannot reliably claim "tile not in Hygglo" at this pass.
  if (allWidgetTiles.length === 0) {
    buckets.missing_tile.push({ order_id: order.order_id, account: order.account, renter: order.renter_name, hygglo_item: hyItems[0]?.name });
  }
}

// Orphan convex (no matching Hygglo order)
for (const r of reservations) {
  if (r.hygglo_order_id && !seenHyggloOrders.has(String(r.hygglo_order_id))) {
    buckets.orphan_convex_no_hygglo.push({ reservation_id: r._id, hygglo_order_id: r.hygglo_order_id, account: r.account_slug });
  }
}

// Extra-tile pass: tiles with src basenames not in any hygglo image basename of in-window orders
const hyAllBasenames = new Set();
for (const o of orders) {
  for (const it of (o.items || [])) {
    for (const u of (it.image_urls || [])) {
      const b = norm(u); if (b) hyAllBasenames.add(b);
    }
  }
}
const widgetAllBasenames = new Map(); // basename -> tile sample
for (const w of widgets) {
  for (const t of w.tiles) {
    const b = norm(t.src);
    if (!b) continue;
    if (!widgetAllBasenames.has(b)) widgetAllBasenames.set(b, { widget: w.name, alt: t.alt, src: t.src });
  }
}
for (const [b, sample] of widgetAllBasenames) {
  if (!hyAllBasenames.has(b)) {
    buckets.extra_tile.push({ widget: sample.widget, alt: sample.alt, basename: b });
  }
}

// ---------- summary stats ----------
const totalGT = orders.length;
const totalCV = reservations.length;
const matchedToCv = rows.filter(r => r.convex_reservation_id).length;
const unbacked    = buckets.unbacked_in_convex.length;
const orphans     = buckets.orphan_convex_no_hygglo.length;
const wrongCount  = buckets.wrong_image.length;
const dupCount    = buckets.duplicate_image.length;
const missingTiles= buckets.missing_tile.length;
const extraTiles  = buckets.extra_tile.length;
const lagCount    = buckets.resolver_lag.length;
const cntMismatch = buckets.count_mismatch.length;

const summary = {
  generated_at: new Date().toISOString(),
  hygglo_orders: totalGT,
  convex_reservations: totalCV,
  matched_to_convex: matchedToCv,
  unbacked_in_convex: unbacked,
  orphan_convex_no_hygglo: orphans,
  count_mismatch_rows: cntMismatch,
  resolver_lag_rows: lagCount,
  wrong_image_findings: wrongCount,
  duplicate_image_rentals: dupCount,
  rentals_with_zero_widget_tiles: missingTiles,
  widget_tiles_without_matching_hygglo_basename: extraTiles,
  widget_unique_basenames: widgetAllBasenames.size,
  hygglo_unique_basenames: hyAllBasenames.size,
};

// ---------- worst-10 rentals ----------
function severity(row) {
  let s = 0;
  for (const d of row.items) {
    if (d.convex_basename && d.hygglo_basename && d.convex_basename !== d.hygglo_basename) s += 3;
    if (d.widget_wrong) s += 2;
    if (d.widget_missing) s += 1;
  }
  s += row.duplicate_image_basenames.length * 3;
  if (row.hygglo_item_count !== row.convex_resolved_count && !row.resolver_lag) s += 2;
  return s;
}
const worst = rows
  .map(r => ({ row: r, score: severity(r) }))
  .filter(x => x.score > 0)
  .sort((a,b)=>b.score-a.score)
  .slice(0, 10);

// ---------- write JSON ----------
fs.writeFileSync(OUT_JSON, JSON.stringify({ summary, buckets, rows, worst: worst.map(w=>({order_id:w.row.order_id,score:w.score})) }, null, 2));

// ---------- write Markdown ----------
const md = [];
md.push(`# MISMATCH Report — Pass 1`);
md.push(`Generated: ${summary.generated_at}`);
md.push('');
md.push(`## Headline numbers`);
md.push('| Metric | Value |');
md.push('|---|---|');
md.push(`| Hygglo orders in window | ${summary.hygglo_orders} |`);
md.push(`| Convex reservations | ${summary.convex_reservations} |`);
md.push(`| Hygglo orders backed in Convex | ${summary.matched_to_convex} / ${summary.hygglo_orders} (${((summary.matched_to_convex/Math.max(1,summary.hygglo_orders))*100).toFixed(0)}%) |`);
md.push(`| Hygglo orders NOT in Convex (unbacked) | ${summary.unbacked_in_convex} |`);
md.push(`| Convex reservations with no Hygglo (orphan) | ${summary.orphan_convex_no_hygglo} |`);
md.push(`| Resolver-lag rentals (resolved_items empty) | ${summary.resolver_lag_rows} |`);
md.push(`| Item-count mismatch rentals | ${summary.count_mismatch_rows} |`);
md.push(`| WRONG-IMAGE findings (item-level) | ${summary.wrong_image_findings} |`);
md.push(`| DUPLICATE-IMAGE rentals | ${summary.duplicate_image_rentals} |`);
md.push(`| Rentals with ZERO widget tiles | ${summary.rentals_with_zero_widget_tiles} |`);
md.push(`| Widget tiles whose basename has no matching Hygglo order in window | ${summary.widget_tiles_without_matching_hygglo_basename} (of ${summary.widget_unique_basenames} unique) |`);
md.push('');
md.push(`## Bucket 1 — WRONG IMAGE`);
md.push(`Total findings: ${buckets.wrong_image.length}`);
md.push('');
md.push('| order_id | account | renter | item | hygglo basename | convex/widget basename | surface |');
md.push('|---|---|---|---|---|---|---|');
for (const w of buckets.wrong_image) {
  const other = w.convex || (Array.isArray(w.widget) ? w.widget.join(',') : w.widget);
  md.push(`| ${w.order_id} | ${w.account} | ${w.renter} | ${(w.item||'').slice(0,60)} | ${w.hygglo} | ${other} | ${w.surface || 'convex'} |`);
}
md.push('');
md.push(`## Bucket 2 — DUPLICATE IMAGE (same Convex image_url on ≥2 distinct items in same rental)`);
md.push(`Total rentals: ${buckets.duplicate_image.length}`);
md.push('');
for (const d of buckets.duplicate_image) {
  md.push(`### Order ${d.order_id} (${d.account}, ${d.renter})`);
  md.push(`Duplicated basenames: ${d.duplicates.join(', ')}`);
  md.push('');
  md.push('| item | convex basename |');
  md.push('|---|---|');
  for (const it of d.items) md.push(`| ${(it.name||'').slice(0,70)} | ${it.basename||'—'} |`);
  md.push('');
}
md.push(`## Bucket 3 — MISSING TILE (Hygglo order has zero matching widget tile across all 4 widgets)`);
md.push(`Total: ${buckets.missing_tile.length}`);
md.push('');
md.push('| order_id | account | renter | first-item |');
md.push('|---|---|---|---|');
for (const m of buckets.missing_tile) md.push(`| ${m.order_id} | ${m.account} | ${m.renter} | ${(m.hygglo_item||'').slice(0,60)} |`);
md.push('');
md.push(`## Bucket 4 — EXTRA TILE (widget tile basename not in any in-window Hygglo order image)`);
md.push(`Total unique basenames: ${buckets.extra_tile.length}`);
md.push('');
md.push('| widget | basename | alt (first 60) |');
md.push('|---|---|---|');
for (const e of buckets.extra_tile.slice(0, 80)) md.push(`| ${e.widget} | ${e.basename} | ${(e.alt||'').slice(0,60).replace(/\|/g,'/')} |`);
if (buckets.extra_tile.length > 80) md.push(`| … | … | (+${buckets.extra_tile.length-80} more) |`);
md.push('');
md.push(`## Bucket 5 — UNBACKED (Hygglo order missing from Convex)`);
md.push(`Total: ${buckets.unbacked_in_convex.length}`);
md.push('');
md.push('| order_id | account | renter |');
md.push('|---|---|---|');
for (const u of buckets.unbacked_in_convex) md.push(`| ${u.order_id} | ${u.account} | ${u.renter} |`);
md.push('');
md.push(`## Bucket 6 — ORPHAN (Convex reservation, no Hygglo order in window)`);
md.push(`Total: ${buckets.orphan_convex_no_hygglo.length}`);
md.push('');
md.push('| reservation_id | hygglo_order_id | account |');
md.push('|---|---|---|');
for (const o of buckets.orphan_convex_no_hygglo) md.push(`| ${o.reservation_id} | ${o.hygglo_order_id} | ${o.account} |`);
md.push('');
md.push(`## Bucket 7 — RESOLVER LAG (reservation exists, resolved_items empty)`);
md.push(`Total: ${buckets.resolver_lag.length}`);
md.push('');
md.push('| order_id | account | reservation_id |');
md.push('|---|---|---|');
for (const r of buckets.resolver_lag) md.push(`| ${r.order_id} | ${r.account} | ${r.reservation_id} |`);
md.push('');
md.push(`## Bucket 8 — ITEM-COUNT MISMATCH (Hygglo items count ≠ Convex resolved items count)`);
md.push(`Total: ${buckets.count_mismatch.length}`);
md.push('');
md.push('| order_id | hygglo items | convex resolved |');
md.push('|---|---|---|');
for (const c of buckets.count_mismatch) md.push(`| ${c.order_id} | ${c.hygglo} | ${c.convex} |`);
md.push('');
md.push(`## Per-rental detail (every rental in ground-truth window)`);
md.push('');
for (const row of rows) {
  md.push(`### Order ${row.order_id} — ${row.account} — ${row.renter_name}`);
  md.push(`Dates: ${row.start?.slice(0,10)} → ${row.end?.slice(0,10)} | Hygglo items: ${row.hygglo_item_count} | Convex resolved: ${row.convex_resolved_count} | Convex res_id: ${row.convex_reservation_id || '—'} | Resolver lag: ${row.resolver_lag} | Widget tiles linked: ${row.widget_tile_count}`);
  if (row.duplicate_image_basenames.length) md.push(`**Duplicate Convex image basenames in this rental:** ${row.duplicate_image_basenames.join(', ')}`);
  md.push('');
  md.push('| # | Hygglo item | Hygglo basename | Convex basename | Widget basenames | Convex OK | Widget OK |');
  md.push('|---|---|---|---|---|---|---|');
  let i = 0;
  for (const d of row.items) {
    const mark = (ok) => ok ? 'MATCH' : (d.convex_missing ? 'MISSING' : 'MISMATCH');
    md.push(`| ${++i} | ${(d._detail.hygglo.name||'').slice(0,55)} | ${d.hygglo_basename||'—'} | ${d.convex_basename||'—'} | ${d.widget_basenames.join(', ')||'—'} | ${mark(d.convex_match)} | ${d.widget_match ? 'MATCH' : (d.widget_missing ? 'MISSING' : 'MISMATCH')} |`);
  }
  md.push('');
}
md.push(`## CONFIRMED ROOT-CAUSE-EVIDENCE rentals (top ${worst.length} by severity score)`);
md.push('Use these as the architect anchors in Phase 5.');
md.push('');
md.push('| rank | order_id | account | renter | score | reasons |');
md.push('|---|---|---|---|---|---|');
let rank = 0;
for (const w of worst) {
  const r = w.row;
  const reasons = [];
  if (r.duplicate_image_basenames.length) reasons.push(`dup-img×${r.duplicate_image_basenames.length}`);
  const wrongCv = r.items.filter(d => d.convex_basename && d.hygglo_basename && d.convex_basename !== d.hygglo_basename).length;
  if (wrongCv) reasons.push(`wrong-convex-img×${wrongCv}`);
  const wWrong = r.items.filter(d => d.widget_wrong).length;
  if (wWrong) reasons.push(`wrong-widget-img×${wWrong}`);
  const wMiss = r.items.filter(d => d.widget_missing).length;
  if (wMiss) reasons.push(`no-widget-tile×${wMiss}`);
  if (r.hygglo_item_count !== r.convex_resolved_count && !r.resolver_lag) reasons.push(`item-count(${r.hygglo_item_count}vs${r.convex_resolved_count})`);
  md.push(`| ${++rank} | ${r.order_id} | ${r.account} | ${r.renter_name} | ${w.score} | ${reasons.join(', ')} |`);
}
md.push('');
fs.writeFileSync(OUT_MD, md.join('\n'));

// Brief stdout
console.log(JSON.stringify({
  hygglo_orders: totalGT,
  convex_reservations: totalCV,
  matched_to_convex: matchedToCv,
  buckets: {
    wrong_image: wrongCount,
    duplicate_image: dupCount,
    missing_tile: missingTiles,
    extra_tile: extraTiles,
    unbacked: unbacked,
    orphan: orphans,
    resolver_lag: lagCount,
    count_mismatch: cntMismatch,
  },
  worst_n: worst.length,
  out_md: OUT_MD,
  out_json: OUT_JSON,
}, null, 2));
