// Phase 5.4 backfill: populate acquisition_cost_gbp on items table.
// v1's ACQUISITION_COSTS list doesn't cover the actual v2 inventory items,
// so we use a curated cost map based on typical UK used market prices.
// Run: node scripts/backfill-acquisition-costs.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = '/home/ubuntu/rental-manager-v2';
const BATCH = 100;

function runConvex(fn, args) {
  const argJson = JSON.stringify(args);
  const r = spawnSync('npx', ['convex', 'run', fn, argJson], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`convex ${fn} failed: ${r.stderr}`);
  const out = r.stdout.trim();
  const lines = out.split('\n');
  let jsonStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('{') || lines[i].trim().startsWith('[')) {
      jsonStart = i;
      break;
    }
  }
  const jsonText = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : out;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`failed to parse convex output for ${fn}: ${out.slice(0, 500)}`);
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Curated acquisition costs for v2 inventory (UK used market prices, GBP).
// These are conservative estimates based on typical used camera market prices.
const CURATED_COSTS = {
  // Cameras
  'Sony FX3': 2200,
  'Sony A7 V': 2800,
  'Sony A7 III': 1400,
  'Sony A7 II': 700,
  'BMPCC 6K Pro': 1200,
  'BMPCC 6K Full Frame': 1500,
  'Fujifilm X100 VI': 1200,
  'DJI Osmo Action Pro 5': 280,
  'GoPro 12 Hero': 280,
  // Lenses
  'Sony GM 24-70mm f2.8': 1800,
  'Sony GM 70-200mm f2.8': 2000,
  'Sony GM 16-35mm f2.8': 1800,
  'Sony GM 90mm f2.8': 900,
  'Sony 28-70mm': 200,
  'Canon EF 24-105mm f4': 350,
  'Canon EF 16-35mm f2.8': 600,
  'Sony 11mm f2.8 fisheye': 400,
  'Anamorphic Blazar Remus 33mm': 900,
  'Anamorphic Blazar Remus 45mm': 900,
  'Anamorphic Blazar Remus 65mm': 900,
  'Anamorphic Blazar Remus 100mm': 900,
  // Mounts/adapters
  'PL to Sony E mount': 150,
  'PL to EF mount': 150,
  'PL to RF mount': 150,
  'PL to L mount': 150,
  // Drones
  'DJI Mavic 3 Pro': 1600,
  'DJI Mini 4 Pro': 650,
  // Stabilizers / support
  'DJI RS3 Pro gimbal': 550,
  'Tilta Nucleus Nano 2 follow focus': 250,
  'Motorized slider': 500,
  'Tilta shoulder rig': 350,
  'Small rig tripod': 120,
  'Sirui tripod': 250,
  'Monopod arm support': 80,
  'C-stand': 80,
  'Suction cups': 120,
  // Audio
  'Rode Wireless Mic Pro set': 350,
  'DJI Wireless Mics': 300,
  'DJI Mic 2 wireless': 200,
  'Rode Video Mic Go': 60,
  'Rode Video Mic Pro Plus': 150,
  'JBL wireless microphones': 150,
  'Audio boom mic Sennheiser': 400,
  // Lighting
  'Nanlite 500B': 700,
  'Nanlite Forza 300': 600,
  'Nanlite Pavotube 30x II': 350,
  'LED light panels RGB': 120,
  'Ambitful RGB light tubes 2x set': 80,
  'Softbox 85cm': 60,
  'Camera flash': 80,
  '5-in-1 reflector panel': 30,
  // FX
  'Smoke machine fogger': 300,
  'Smoke Ninja Pro hazer': 450,
  'Smoke Ninja': 200,
  // Monitors / transmission
  'Atomos Ninja V': 450,
  'Hollyland 7-inch monitor': 250,
  'Hollyland Mars 4K transmitter': 450,
  'Hollyland Pyro S transmitter': 350,
  // Power / batteries
  'V-mount 95mAh': 200,
  'V-mount 150mAh': 350,
  'Anker Power Station F2000': 700,
  'Sony NP-FZ100 batteries 2x sets': 60,
  'Sony NP-F970 batteries 2x sets': 60,
  'DJI gimbal battery': 50,
  // Storage
  '256GB card': 40,
  'CF Express Type A card': 120,
  // Filters
  'ND filter': 80,
  'Cinebloom filter mist': 60,
  // DJ/Audio
  'JBL Club 120 speaker': 500,
  'JBL PartyBox 110': 400,
  'DJ RX3 Pioneer controller': 600,
};

async function main() {
  console.log('[backfill-acq] start — using curated cost map');

  // Get current v2 items
  const v2Items = runConvex('seed/inventory:listAllItemNames', {});
  console.log(`[backfill-acq] v2 active items: ${v2Items.length}`);

  const payload = [];
  const noMatch = [];

  for (const item of v2Items) {
    const cost = CURATED_COSTS[item.name_canonical];
    if (cost && cost > 0) {
      // Only update if not already set
      if (!item.acquisition_cost_gbp || item.acquisition_cost_gbp === 0) {
        payload.push({
          name_canonical: item.name_canonical,
          acquisition_cost_gbp: cost,
        });
      }
    } else {
      noMatch.push(item.name_canonical);
    }
  }

  console.log(`[backfill-acq] items with curated cost: ${payload.length}`);
  console.log(`[backfill-acq] items without cost mapping: ${noMatch.length}`);
  if (noMatch.length > 0) {
    console.log(`[backfill-acq] no-match items: ${noMatch.join(', ')}`);
  }

  let totalUpdated = 0;
  let totalNotFound = 0;
  let batchNum = 0;

  for (const batch of chunk(payload, BATCH)) {
    batchNum++;
    const res = runConvex('seed/data:backfillItemAcquisitionCostsBatch', { rows: batch });
    totalUpdated += res.updated;
    totalNotFound += res.not_found;
    console.log(`[backfill-acq] batch ${batchNum}: updated=${res.updated} not_found=${res.not_found}`);
  }

  const summary = {
    v2_active_items: v2Items.length,
    curated_cost_entries: Object.keys(CURATED_COSTS).length,
    payload_rows: payload.length,
    no_match_count: noMatch.length,
    no_match_items: noMatch,
    total_updated: totalUpdated,
    total_not_found: totalNotFound,
  };
  writeFileSync('/tmp/backfill_acq_log.json', JSON.stringify(summary, null, 2));
  console.log('[backfill-acq] done', summary);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
