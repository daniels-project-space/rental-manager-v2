// Build Convex seed payloads from /tmp/v1-extract.json + Daniel's canonical list.
// Output: /tmp/seed-payloads.json
import { readFileSync, writeFileSync } from 'node:fs';

const v1 = JSON.parse(readFileSync('/tmp/v1-extract.json', 'utf8'));

// Daniel's 72-SKU list (active) + 4 inactive
// Format: [name_input, qty, kind, sub_kind, unit_kind]
const DANIEL_LIST = [
  // Anamorphic lenses (4)
  ['Anamorphic Blazer Remus 33mm', 1, 'lens', 'anamorphic', 'unit'],
  ['Anamorphic blazar Remus 45mm', 1, 'lens', 'anamorphic', 'unit'],
  ['Anamorphic blazar Remus 65mm', 1, 'lens', 'anamorphic', 'unit'],
  ['Anamorphic blazar Remus 100mm', 1, 'lens', 'anamorphic', 'unit'],
  // Sony lenses (6)
  ['Sony gm 24-70mm f2.8 lens', 4, 'lens', 'zoom', 'unit'],
  ['Sony gm 16-35mm f2.8 lens', 1, 'lens', 'zoom', 'unit'],
  ['Sony gm 70-200mm f2.8 lens', 2, 'lens', 'telephoto', 'unit'],
  ['Sony gm 90mm f2.8 lens', 1, 'lens', 'macro', 'unit'],
  ['Sony 28-70mm lens', 2, 'lens', 'zoom', 'unit'],
  ['Sony 11mm f2.8 fisheye lens', 1, 'lens', 'fisheye', 'unit'],
  // Canon lenses (2)
  ['Cannon ef 24-105mm f4 lens', 1, 'lens', 'zoom', 'unit'],
  ['Cannon ef 16-35mm f2.8 lens', 1, 'lens', 'zoom', 'unit'],
  // Cameras (7)
  ['Sony fx 3 camera', 3, 'camera', 'cine', 'unit'],
  ['Sony a7 iii camera', 1, 'camera', 'mirrorless', 'unit'],
  ['Sony a7 ii camera', 1, 'camera', 'mirrorless', 'unit'],
  ['Bmpcc 6k pro camera', 1, 'camera', 'cine', 'unit'],
  ['Bmpcc6k full frame camera', 1, 'camera', 'cine', 'unit'],
  ['Sony a7 v camera', 1, 'camera', 'mirrorless', 'unit'],
  // Lighting (5)
  ['Soft box 85cm', 2, 'lighting', 'modifier', 'unit'],
  ['led light panels rgb', 3, 'lighting', 'led_panel', 'unit'],
  ['Nanlite forza 300 light', 1, 'lighting', 'forza', 'unit'],
  ['Nanlite pavotube 30x ii', 4, 'lighting', 'led_tube', 'unit'],
  ['Nanlite 500 b light', 1, 'lighting', 'led_panel', 'unit'],
  // Power & batteries (5)
  ['V mount batteries 95 mah', 2, 'power', 'v_mount_battery', 'unit'],
  ['V mount batteries 150 mah', 4, 'power', 'v_mount_battery', 'unit'],
  ['Dji gimbal battery', 3, 'power', 'gimbal_battery', 'unit'],
  ['Anker power station f2000', 1, 'power', 'power_station', 'unit'],
  ['Sony Npf 970 batteries 2x sets', 4, 'power', 'np_f970', 'kit'],
  // Support & gimbals (8)
  ['C stand', 1, 'grip', 'c_stand', 'unit'],
  ['Small rig tripod', 3, 'support', 'tripod', 'unit'],
  ['Sirui tripod', 1, 'support', 'tripod', 'unit'],
  ['Dji rs 3 pro gimbal', 2, 'gimbal', 'rs3_pro', 'unit'],
  ['Motorized slider', 1, 'motion', 'slider', 'unit'],
  ['Tilts nucleus nano 2 follow focus', 1, 'stabilizer', 'follow_focus', 'unit'],
  ['Tilta shoulder rig', 1, 'support', 'shoulder_rig', 'unit'],
  ['Monopod arm support', 1, 'support', 'monopod', 'unit'],
  // Action cams & drones (5)
  ['Dji osmo action pro 5 camera', 3, 'camera', 'action', 'unit'],
  ['Dji Mavic 3 pro drone', 1, 'drone', 'mavic_3_pro', 'unit'],
  ['Dji mini 4 pro drone', 1, 'drone', 'mini_4_pro', 'unit'],
  ['Go pro 12 hero camera', 3, 'camera', 'action', 'unit'],
  ['Suction cups accessory', 6, 'accessory', 'mount', 'unit'],
  // Monitors & transmitters (4)
  ['Atomos ninja v monitor recorder', 1, 'monitor', 'recorder', 'unit'],
  ['Holly Land mars 4k transmitter', 1, 'transmission', 'wireless_video', 'unit'],
  ['HollyLand pyro s transmitter', 1, 'transmission', 'wireless_video', 'unit'],
  ['Hollyland 7 inch monitor', 1, 'monitor', 'on_camera', 'unit'],
  // Audio (8)
  ['Rode video mic go', 1, 'audio', 'on_camera_mic', 'unit'],
  ['Rode wireless mic pro set', 2, 'audio', 'wireless_mic', 'set'],
  ['Audio boom mic kit Senheiser', 2, 'audio', 'boom_mic', 'kit'],
  ['Dji wireless mics', 1, 'audio', 'wireless_mic', 'set'],
  ['Camera flash add on', 1, 'lighting', 'flash', 'unit'],
  ['Rode video mic pro plus', 1, 'audio', 'on_camera_mic', 'unit'],
  ['Jbl wireless microphones', 1, 'audio', 'wireless_mic', 'set'],
  ['Dji mic 2 wireless set', 1, 'audio', 'wireless_mic', 'set'],
  // Smoke & effects (3)
  ['Smoke machine fogger event', 1, 'smoke_fx', 'fogger', 'unit'],
  ['Smoke ninja pro hazer', 1, 'smoke_fx', 'hazer', 'unit'],
  ['Smoke ninja', 1, 'smoke_fx', 'compact', 'unit'],
  // DJ & speakers (3)
  ['DJ rx 3 pioneer controller', 1, 'dj_audio', 'controller', 'unit'],
  ['Jbl club 120 speaker', 2, 'dj_audio', 'speaker', 'unit'],
  // Accessories (5)
  ['Nd filter', 3, 'accessory', 'filter', 'unit'],
  ['256gb card', 3, 'storage_card', 'sd', 'unit'],
  ['Cinebloom filter mist', 1, 'accessory', 'filter', 'unit'],
  ['Cf express type a card', 3, 'storage_card', 'cfexpress_a', 'unit'],
  ['Ambitful rgb light tubes 2x set', 2, 'lighting', 'led_tube', 'set'],
  // Lens mount adapters (4)
  ['Pl to Sony e mount adapter', 2, 'accessory', 'mount_adapter', 'unit'],
  ['Pl to ef mount adapter', 1, 'accessory', 'mount_adapter', 'unit'],
  ['Pl to rf mount adapter', 1, 'accessory', 'mount_adapter', 'unit'],
  ['Pl to l mount adapter', 1, 'accessory', 'mount_adapter', 'unit'],
  // Reflectors
  ['5 in 1 reflector panel', 1, 'lighting', 'reflector', 'unit'],
];

// Active count from Daniel's actual paste = 68 (header said 72 but paste has 68)
// Discrepancy logged in audit_log + final report.
if (DANIEL_LIST.length !== 68) {
  console.error('Daniel list count != 68:', DANIEL_LIST.length);
  process.exit(1);
}

// Inactive items (qty 0)
const INACTIVE_LIST = [
  ['Anamorphic great joy lens 35mm', 0, 'lens', 'anamorphic', 'unit', 'marketing_only'],
  ['Anamorphic great joy lens 50mm', 0, 'lens', 'anamorphic', 'unit', 'marketing_only'],
  ['Anamorphic great joy lens 85mm', 0, 'lens', 'anamorphic', 'unit', 'marketing_only'],
  ['Fujifilm x100 vi camera', 0, 'camera', 'mirrorless', 'unit', 'inactive'],
];

// Daniel input → v1 canonical map
const DANIEL_TO_V1 = {
  'Anamorphic Blazer Remus 33mm': 'Anamorphic Blazar Remus 33mm',
  'Anamorphic blazar Remus 45mm': 'Anamorphic Blazar Remus 45mm',
  'Anamorphic blazar Remus 65mm': 'Anamorphic Blazar Remus 65mm',
  'Anamorphic blazar Remus 100mm': 'Anamorphic Blazar Remus 100mm',
  'Sony gm 24-70mm f2.8 lens': 'Sony GM 24-70mm f2.8',
  'Sony gm 16-35mm f2.8 lens': 'Sony GM 16-35mm f2.8',
  'Sony gm 70-200mm f2.8 lens': 'Sony GM 70-200mm f2.8',
  'Sony gm 90mm f2.8 lens': 'Sony GM 90mm f2.8',
  'Sony 28-70mm lens': 'Sony 28-70mm',
  'Sony 11mm f2.8 fisheye lens': 'Sony 11mm f2.8 fisheye',
  'Cannon ef 24-105mm f4 lens': 'Canon EF 24-105mm f4',
  'Cannon ef 16-35mm f2.8 lens': 'Canon EF 16-35mm f2.8',
  'Sony fx 3 camera': 'Sony FX3',
  'Sony a7 iii camera': 'Sony A7 III',
  'Sony a7 ii camera': 'Sony A7 II',
  'Bmpcc 6k pro camera': 'BMPCC 6K Pro',
  'Bmpcc6k full frame camera': 'BMPCC 6K Full Frame',
  'Sony a7 v camera': 'Sony A7 V',
  'Soft box 85cm': 'Softbox 85cm',
  'led light panels rgb': 'LED light panels RGB',
  'Nanlite forza 300 light': 'Nanlite Forza 300',
  'Nanlite pavotube 30x ii': 'Nanlite Pavotube 30x II',
  'Nanlite 500 b light': 'Nanlite 500B',
  'V mount batteries 95 mah': 'V-mount 95mAh',
  'V mount batteries 150 mah': 'V-mount 150mAh',
  'Dji gimbal battery': 'DJI gimbal battery',
  'Anker power station f2000': 'Anker Power Station F2000',
  'Sony Npf 970 batteries 2x sets': 'Sony NPF 970 batteries 2x sets',
  'C stand': 'C-stand',
  'Small rig tripod': 'Small rig tripod',
  'Sirui tripod': 'Sirui tripod',
  'Dji rs 3 pro gimbal': 'DJI RS3 Pro gimbal',
  'Motorized slider': 'Motorized slider',
  'Tilts nucleus nano 2 follow focus': 'Tilta Nucleus Nano 2 follow focus',
  'Tilta shoulder rig': 'Tilta shoulder rig',
  'Monopod arm support': 'Monopod arm support',
  'Dji osmo action pro 5 camera': 'DJI Osmo Action Pro 5',
  'Dji Mavic 3 pro drone': 'DJI Mavic 3 Pro',
  'Dji mini 4 pro drone': 'DJI Mini 4 Pro',
  'Go pro 12 hero camera': 'GoPro 12 Hero',
  'Suction cups accessory': 'Suction cups',
  'Atomos ninja v monitor recorder': 'Atomos Ninja V',
  'Holly Land mars 4k transmitter': 'Hollyland Mars 4K transmitter',
  'HollyLand pyro s transmitter': 'Hollyland Pyro S transmitter',
  'Hollyland 7 inch monitor': 'Hollyland 7-inch monitor',
  'Rode video mic go': 'Rode Video Mic Go',
  'Rode wireless mic pro set': 'Rode Wireless Mic Pro set',
  'Audio boom mic kit Senheiser': 'Audio boom mic Sennheiser',
  'Dji wireless mics': 'DJI Wireless Mics',
  'Camera flash add on': 'Camera flash',
  'Rode video mic pro plus': 'Rode Video Mic Pro Plus',
  'Jbl wireless microphones': 'JBL wireless microphones',
  'Dji mic 2 wireless set': 'DJI Mic 2 wireless',
  'Smoke machine fogger event': 'Smoke machine fogger',
  'Smoke ninja pro hazer': 'Smoke Ninja Pro hazer',
  'Smoke ninja': 'Smoke Ninja',
  'DJ rx 3 pioneer controller': 'DJ RX3 Pioneer controller',
  'Jbl club 120 speaker': 'JBL Club 120 speaker',
  'Nd filter': 'ND filter',
  '256gb card': '256GB card',
  'Cinebloom filter mist': 'Cinebloom filter mist',
  'Cf express type a card': 'CF Express Type A card',
  'Ambitful rgb light tubes 2x set': 'Ambitful RGB light tubes 2x set',
  'Pl to Sony e mount adapter': 'PL to Sony E mount',
  'Pl to ef mount adapter': 'PL to EF mount',
  'Pl to rf mount adapter': 'PL to RF mount',
  'Pl to l mount adapter': 'PL to L mount',
  '5 in 1 reflector panel': '5-in-1 reflector panel',
  // Inactive
  'Anamorphic great joy lens 35mm': 'Anamorphic Great Joy lens 35mm',
  'Anamorphic great joy lens 50mm': 'Anamorphic Great Joy lens 50mm',
  'Anamorphic great joy lens 85mm': 'Anamorphic Great Joy lens 85mm',
  'Fujifilm x100 vi camera': 'Fujifilm X100 VI',
};

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const itemSpecsByName = Object.fromEntries((v1.itemSpecs.value || []).map(s => [s.item_name, s]));
const itemCompByName = Object.fromEntries((v1.itemCompatibility.value || []).map(c => [c.item_name, c]));
const deliveryByName = Object.fromEntries((v1.delivery.value || []).map(d => [d.item_name, d]));
const replacementByName = v1.replacementCosts?.value || {}; // it's an object {name: cost} - check
const acquisitionByName = Object.fromEntries((v1.acquisition.value || []).map(a => [a.name, a]));

// Build items + specs payloads
const items = [];
const specs = [];

for (const row of DANIEL_LIST) {
  const [name_input, qty, kind, sub_kind, unit_kind] = row;
  const name_canonical = DANIEL_TO_V1[name_input] || name_input;
  const slug = slugify(name_canonical);
  const specEntry = itemSpecsByName[name_canonical];
  const compEntry = itemCompByName[name_canonical];
  const delEntry = deliveryByName[name_canonical];
  const acqEntry = acquisitionByName[name_canonical];
  const replacement = (replacementByName && typeof replacementByName === 'object')
    ? replacementByName[name_canonical]
    : undefined;

  items.push({
    name_canonical,
    name_input,
    slug,
    kind,
    sub_kind,
    qty,
    unit_kind,
    weight_kg: delEntry?.weight_kg,
    length_cm: delEntry?.packed_length_cm,
    width_cm: delEntry?.packed_width_cm,
    height_cm: delEntry?.packed_height_cm,
    size_score: delEntry?.size_score,
    category_v1: delEntry?.category,
    notes: delEntry?.courier_note,
    lens_mount: compEntry?.lens_mount,
    battery_type: compEntry?.battery_type,
    card_type: compEntry?.card_type,
    compatibility: compEntry ? {
      batteries: compEntry.compatible_batteries,
      cards: compEntry.compatible_cards,
      lenses: compEntry.compatible_lenses,
      accessories: compEntry.compatible_accessories,
      included_with_rental: compEntry.included_with_rental,
    } : undefined,
    delivery_notes: delEntry?.courier_note,
    replacement_cost_gbp: typeof replacement === 'number' ? replacement : undefined,
    acquisition_cost_gbp: acqEntry?.cost_gbp,
    is_marketing_only: false,
    status: 'active',
    description_source: specEntry ? 'v1-handwritten' : undefined,
  });
  if (specEntry?.specs) {
    specs.push({
      item_name_canonical: name_canonical,
      description: specEntry.specs,
      source: 'v1-handwritten',
    });
  }
}

for (const row of INACTIVE_LIST) {
  const [name_input, qty, kind, sub_kind, unit_kind, status] = row;
  const name_canonical = DANIEL_TO_V1[name_input] || name_input;
  const slug = slugify(name_canonical);
  const specEntry = itemSpecsByName[name_canonical];
  items.push({
    name_canonical,
    name_input,
    slug,
    kind,
    sub_kind,
    qty,
    unit_kind,
    is_marketing_only: status === 'marketing_only',
    status,
    description_source: specEntry ? 'v1-handwritten' : undefined,
  });
  if (specEntry?.specs) {
    specs.push({
      item_name_canonical: name_canonical,
      description: specEntry.specs,
      source: 'v1-handwritten',
    });
  }
}

// Bundles — v1 BUNDLE_DEFINITIONS already use v1 canonical names
const bundles = (v1.bundles.value || []).map(b => ({
  slug: slugify(b.bundle_name),
  bundle_name: b.bundle_name,
  daily_price_min: b.daily_price_min,
  daily_price_max: b.daily_price_max,
  use_cases: b.use_cases,
  trigger_keywords: b.trigger_keywords,
  savings_note: b.savings_note,
  delivery_note: b.delivery_note,
  account_scope: 'both',
  items: (b.items || []).map(name => ({ item_name_canonical: name, qty: 1 })),
}));

// Marketing redirects
const redirects = (v1.marketingRedirects.value || []).map(r => ({
  marketing_name: r.marketingItem,
  real_item_name_canonical: r.realAlternative,
  selling_point: r.sellingPoint,
  category: r.category,
}));

// Pricing catalog
const pricing = (v1.pricing.value || []).map(p => ({
  item_name_canonical: p.item_name,
  category: p.category,
  daily_price_min: p.daily_price_min,
  daily_price_max: p.daily_price_max,
  is_bundle: !!p.is_bundle,
  bundle_items: p.bundle_items,
  multi_day_notes: p.multi_day_notes,
  marketing_only: p.marketing_only ?? false,
}));

// Listing photos
const listingPhotosObj = v1.listingPhotos.value || {};
const listingPhotos = Object.values(listingPhotosObj).map(lp => ({
  listing_id: lp.listing_id,
  account_slug: lp.account,
  items: (lp.items || []).map(i => ({ item_name: i.item, qty: i.qty })),
  included: lp.included,
  notes: lp.notes,
  photo_file: lp.photoFile,
}));

const payload = {
  items,
  specs,
  bundles,
  redirects,
  pricing,
  listingPhotos,
  meta: {
    activeCount: DANIEL_LIST.length,
    inactiveCount: INACTIVE_LIST.length,
    specsCount: specs.length,
    needsGrokFill: items.find(i => !i.description_source && i.status === 'active')?.name_canonical,
  },
};

writeFileSync('/tmp/seed-payloads.json', JSON.stringify(payload, null, 2));
console.log('OK wrote /tmp/seed-payloads.json');
console.log('Items:', items.length, '| Specs:', specs.length, '| Bundles:', bundles.length,
  '| Redirects:', redirects.length, '| Pricing:', pricing.length, '| ListingPhotos:', listingPhotos.length);
console.log('Items missing v1 spec (active):', items.filter(i => i.status === 'active' && !i.description_source).map(i => i.name_canonical));
