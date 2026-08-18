/**
 * Pre-built category map for constrained AI prompts.
 * Instead of sending 170+ items to Claude, we detect category signals from
 * the listing title and send only 15-30 relevant items.
 *
 * Ported verbatim from v1 (rental-manager/src/item-resolver/inventory-categories.ts).
 * Import path adjusted: v1 used '../utils/item-matcher' → v2 uses './item_matcher'.
 */
import { getInventoryItemNames, extractPrimaryBrand } from './item_matcher';

export const INVENTORY_BY_CATEGORY: Record<string, string[]> = {
  cameras: [
    'Sony FX3', 'Sony A7 III',
    'Sony A7 V', 'Sony A7 II', 'Fujifilm X100 VI',
    'BMPCC 6K Pro', 'BMPCC 6K Full Frame',
  ],
  sony_lenses: [
    'Sony GM 24-70mm f2.8', 'Sony GM 16-35mm f2.8', 'Sony GM 70-200mm f2.8',
    'Sony GM 90mm f2.8', 'Sony 28-70mm', 'Sony 11mm f2.8 fisheye',
  ],
  canon_lenses: [
    'Canon EF 24-105mm f4', 'Canon EF 16-35mm f2.8',
  ],
  anamorphic: [
    'Anamorphic Blazar Remus 33mm', 'Anamorphic Blazar Remus 45mm',
    'Anamorphic Blazar Remus 65mm', 'Anamorphic Blazar Remus 100mm',
    'DZO Vespid Prime 16mm T2.1', 'DZO Vespid Prime 25mm T2.1',
    'DZO Vespid Prime 50mm T2.1', 'DZO Vespid Prime 75mm T2.1',
    'DZO Vespid Prime 100mm T2.1', 'DZO Vespid Prime 125mm T2.1',
  ],
  lighting: [
    'Softbox 85cm', 'LED light panels RGB', 'Nanlite Forza 300',
    'Nanlite Pavotube 30x II', 'Nanlite 500B',
    'Ambitful RGB light tubes 2x set', '5-in-1 reflector panel', 'Camera flash',
  ],
  power: [
    'V-mount 95Wh', 'V-mount 150Wh',
    'DJI gimbal battery', 'Anker Power Station F2000',
  ],
  support: [
    'C-stand', 'Small rig tripod', 'Sirui tripod',
    'DJI RS3 Pro gimbal', 'Motorized slider',
    'Tilta Nucleus Nano 2 follow focus', 'Tilta shoulder rig', 'Monopod arm support',
  ],
  monitors: [
    'Atomos Ninja V', 'Hollyland Mars 4K transmitter',
    'Hollyland Pyro S transmitter', 'Hollyland 7-inch monitor',
  ],
  audio: [
    'Rode Video Mic Go', 'Rode Wireless Mic Pro set', 'Rode Video Mic Pro Plus',
    'Audio boom mic Sennheiser', 'DJI Wireless Mics', 'DJI Mic 2 wireless',
    'JBL wireless microphones',
  ],
  drones: [
    'DJI Mavic 3 Pro', 'DJI Mini 4 Pro',
    'DJI Osmo Action Pro 5', 'GoPro 12 Hero', 'Suction cups',
  ],
  dj_speakers: [
    'DJ RX3 Pioneer controller', 'JBL Club 120 speaker',
  ],
  effects: [
    'Smoke machine fogger', 'Smoke Ninja Pro hazer', 'Smoke Ninja',
  ],
  accessories: [
    'ND filter', 'Cinebloom filter mist', '256GB card', 'CF Express Type A card',
    'PL to Sony E mount', 'PL to EF mount', 'PL to RF mount', 'PL to L mount',
    'Sony NP-FZ100 batteries 2x sets', '7Artisans 7.5mm f2.8 Fisheye',
  ],
};

/** Keywords that signal which categories to include in the AI prompt */
export const CATEGORY_SIGNALS: Record<string, string[]> = {
  cameras: ['fx3', 'a7', 'alpha', 'bmpcc', 'blackmagic', 'pocket', 'fujifilm', 'fuji', 'x100', 'x-t5', 'camera', 'cinema'],
  sony_lenses: ['sony', 'gm', 'gmaster', 'g master', '24-70', '16-35', '70-200', '90mm', '28-70', 'fisheye', 'lens'],
  canon_lenses: ['canon', 'ef ', 'rf '],
  lighting: ['led', 'light', 'nanlite', 'forza', 'pavotube', 'softbox', 'reflector', 'panel', 'rgb', 'tube', 'flash', 'strobe', 'ambitful'],
  power: ['v-mount', 'vmount', 'battery', 'batter', 'power station', 'anker', '150mah', '95mah'],
  support: ['tripod', 'gimbal', 'stabiliz', 'slider', 'follow focus', 'tilta', 'shoulder', 'c-stand', 'monopod', 'rs3', 'smallrig', 'small rig'],
  monitors: ['monitor', 'atomos', 'ninja', 'hollyland', 'mars', 'pyro', 'transmit'],
  audio: ['mic', 'microphone', 'rode', 'wireless', 'boom', 'shotgun', 'sennheiser', 'dji mic', 'audio', 'lav', 'lavalier', 'jbl wireless'],
  drones: ['drone', 'mavic', 'mini 4', 'avata', 'action', 'gopro', 'suction', 'osmo'],
  dj_speakers: ['dj', 'pioneer', 'rx2', 'rx3', 'xdj', 'speaker', 'jbl club', 'partybox', 'party box'],
  effects: ['smoke', 'fog', 'haze', 'fogger', 'hazer'],
  accessories: ['nd filter', 'cinebloom', 'cf express', 'memory card', '256gb', 'pl mount', 'adapter'],
};

/**
 * Map dirty/variant names to canonical MASTER_INVENTORY names.
 * Used to clean up itemcatalog entries and AI outputs.
 */
export const CANONICAL_MAP: Record<string, string> = {
  'V-mount battery': 'V-mount 150Wh',
  'V-mount Battery': 'V-mount 150Wh',
  'V mount battery': 'V-mount 150Wh',
  'V mount 150mAh': 'V-mount 150Wh',
  'Video tripod': 'Small rig tripod',
  'video tripod': 'Small rig tripod',
  'SmallRig tripod': 'Small rig tripod',
  'DJI Mic 2': 'DJI Mic 2 wireless',
  'DJI RS3 Pro': 'DJI RS3 Pro gimbal',
  'DJI RS 3 Pro': 'DJI RS3 Pro gimbal',
  'DJI RS3': 'DJI RS3 Pro gimbal',
  'Sony NPF 970 batteries 2x sets': 'Sony NP-F970 batteries 2x sets',
  'Sony NPF 550 batteries': 'Sony NP-F970 batteries 2x sets',
  'Sony NP-F550 batteries': 'Sony NP-F970 batteries 2x sets',
  'NPF 550': 'Sony NP-F970 batteries 2x sets',
  'NPF 970': 'Sony NP-F970 batteries 2x sets',
  'NP-F550': 'Sony NP-F970 batteries 2x sets',
  'NP-F970': 'Sony NP-F970 batteries 2x sets',
  'Sony NP-FZ100 battery': 'Sony NP-FZ100 batteries 2x sets',
};

/**
 * Extract relevant categories from a title string.
 * Returns unique inventory item names from matched categories.
 *
 * v1 signature accepts only `title`; the `detail` 2nd arg in the v2 task spec
 * is reserved for future use and currently unused (kept for forward compat).
 */
export function getRelevantItems(title: string, _detail?: unknown): string[] {
  const lower = title.toLowerCase();
  const matchedCategories = new Set<string>();

  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const signal of signals) {
      if (lower.includes(signal)) {
        matchedCategories.add(category);
        break;
      }
    }
  }

  // Always include cameras if lenses are mentioned (bundles)
  if (matchedCategories.has('sony_lenses') || matchedCategories.has('canon_lenses') || matchedCategories.has('anamorphic')) {
    matchedCategories.add('cameras');
  }
  // Always include support if cameras/lenses mentioned (bundles often have gimbals/tripods)
  if (matchedCategories.has('cameras')) {
    matchedCategories.add('support');
  }
  // Always include audio with cameras for bundle titles
  if (matchedCategories.has('cameras') && (lower.includes('+') || lower.includes('kit') || lower.includes('bundle') || lower.includes('set'))) {
    matchedCategories.add('audio');
  }

  // If no category matched at all, return full inventory (fallback)
  if (matchedCategories.size === 0) {
    return getInventoryItemNames();
  }

  // BRAND ISOLATION: If listing mentions a specific camera/lens brand,
  // exclude the opposite brand's lens category to prevent cross-brand AI matches.
  // e.g., "Canon 70-200mm" should NOT see Sony lenses in the AI prompt.
  const titleBrand = extractPrimaryBrand(title);
  if (titleBrand === 'canon' || titleBrand === 'nikon') {
    matchedCategories.delete('sony_lenses');
  } else if (titleBrand === 'sony') {
    matchedCategories.delete('canon_lenses');
  }
  // Fujifilm uses its own mount system — exclude both Sony and Canon lenses
  if (titleBrand === 'fujifilm') {
    matchedCategories.delete('sony_lenses');
    matchedCategories.delete('canon_lenses');
  }

  const items = new Set<string>();
  for (const cat of matchedCategories) {
    for (const item of INVENTORY_BY_CATEGORY[cat] || []) {
      items.add(item);
    }
  }

  return Array.from(items);
}
