/**
 * LISTING PHOTO REFERENCE DATABANK
 *
 * Generated 2026-02-09 by Claude Code (Opus) from manual photo analysis
 * of 101 downloaded listing images at /tmp/listing-images/
 *
 * Each entry maps a Hygglo listing_id to:
 *   - items: The VERIFIED main rental items visible in the listing photo
 *   - included: Items that come WITH the camera (not separate rental items)
 *   - notes: Any corrections or observations
 *   - account: Which rental account owns this listing
 *   - photoFile: Path to the analyzed image
 *
 * RULES APPLIED:
 * 1. Sony NP-FZ100 batteries come WITH all Sony cameras (FX3, A7III, A7V, A7SII) — NOT a separate rental item
 * 2. Sony NPF 970 batteries are a SEPARATE rental item for monitors/lights — only listed when explicitly present
 * 3. 128GB SD cards come WITH cameras — not a separate rental item unless 256GB+
 * 4. XLR handles come WITH Sony FX3 — not a separate item
 * 5. LP-E6NH batteries come WITH BMPCC cameras — not a separate rental item
 * 6. DJI Intelligent Flight Batteries come WITH drone Fly More kits — not a separate item
 * 7. "DJI gimbal battery" refers ONLY to DJI RS3 Pro gimbal batteries — NOT drone batteries
 * 8. Samsung SSD comes WITH BMPCC rentals as recording media — not a separate item
 * 9. Lens identification: GM = orange G badge + large barrel; 28-70mm = "FE 3.5-5.6/28-70" + no G badge + smaller
 */

export interface ListingPhotoEntry {
  listing_id: string;
  account: 'dbcinema' | 'leo';
  items: Array<{ item: string; qty: number }>;
  included: string[];  // Items that come WITH the main item (not separately rentable)
  notes: string;
  photoFile: string;
}

export const LISTING_PHOTO_REFERENCE: Record<string, ListingPhotoEntry> = {

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — SONY FX3 BUNDLES
  // ═══════════════════════════════════════════════════════════

  '3652188': {
    listing_id: '3652188',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony 28-70mm', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
      { item: 'Rode Wireless Mic Pro set', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '256GB Lexar SD card', 'XLR handle'],
    notes: 'Ardy rental. Photo shows GM 24-70mm marketing image but Daniel confirmed actual lens is 28-70mm. Rode Wireless Mic Pro included but not shown in photo.',
    photoFile: '/tmp/listing-images/3652188.jpg',
  },

  '3724279': {
    listing_id: '3724279',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '256GB Lexar SD card', 'XLR handle'],
    notes: 'Photo clearly shows GM 24-70mm (orange G badge) + DJI RS3 Pro. Same template as Ardy listing.',
    photoFile: '/tmp/listing-images/3724279.jpg',
  },

  '3732878': {
    listing_id: '3732878',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card', 'XLR handle'],
    notes: 'Same bundle template as 3724279. GM lens + gimbal.',
    photoFile: '/tmp/listing-images/3732878.jpg',
  },

  '3637131': {
    listing_id: '3637131',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'Photo shows FX3 + GM 24-70mm (orange G badge). NO gimbal in photo despite title.',
    photoFile: '/tmp/listing-images/3637131.jpg',
  },

  '3731174': {
    listing_id: '3731174',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony 28-70mm', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'Photo clearly shows 28-70mm kit lens (FE 3.5-5.6/28-70 visible, no G badge). Correctly identified.',
    photoFile: '/tmp/listing-images/3731174.jpg',
  },

  '3731644': {
    listing_id: '3731644',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card', 'XLR handle'],
    notes: 'FX3 + GM 24-70mm bundle.',
    photoFile: '/tmp/listing-images/3731644.jpg',
  },

  '3733262': {
    listing_id: '3733262',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'FX3 body only listing.',
    photoFile: '/tmp/listing-images/3733262.jpg',
  },

  '3734250': {
    listing_id: '3734250',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'Rode Video Mic Pro Plus', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card', 'XLR handle'],
    notes: 'FX3 + GM 24-70mm + Rode Video Mic Pro Plus shotgun mic bundle.',
    photoFile: '/tmp/listing-images/3734250.jpg',
  },

  '3733694': {
    listing_id: '3733694',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 2 },
      { item: 'Small rig tripod', qty: 2 },
      { item: 'Sony GM 24-70mm f2.8', qty: 2 },
    ],
    included: ['6x NP-FZ100 batteries', '2x 128GB SD cards', '2x XLR handles'],
    notes: '2x FX3 + 2x GM 24-70mm + 2x tripods multi-cam bundle.',
    photoFile: '/tmp/listing-images/3733694.jpg',
  },

  '3736701': {
    listing_id: '3736701',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 2 },
    ],
    included: ['4x NP-FZ100 batteries', '2x 128GB SanDisk SD cards', '2x XLR handles'],
    notes: '2x FX3 bodies only. Photo shows NO lenses, NO mics, NO Hollyland, NO DJI Wireless despite parsed_items.',
    photoFile: '/tmp/listing-images/3736701.jpg',
  },

  '3730567': {
    listing_id: '3730567',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB AV Pro SD card'],
    notes: 'FX3 + GM 16-35mm. Photo clearly shows only 16-35mm (orange G badge). Parsed_items wrongly included GM 24-70mm.',
    photoFile: '/tmp/listing-images/3730567.jpg',
  },

  '3736477': {
    listing_id: '3736477',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'FX3 + GM 16-35mm. NO Rode mic, NO DJI RS3, NO NPF 970 in photo.',
    photoFile: '/tmp/listing-images/3736477.jpg',
  },

  '3731642': {
    listing_id: '3731642',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'Sony 70-200mm f4 G', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card', 'XLR handle'],
    notes: 'FX3 dual-lens + gimbal bundle.',
    photoFile: '/tmp/listing-images/3731642.jpg',
  },

  '3730908': {
    listing_id: '3730908',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'Sony 70-200mm f4 G', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card', 'XLR handle'],
    notes: 'Same dual-lens + gimbal template as 3731642.',
    photoFile: '/tmp/listing-images/3730908.jpg',
  },

  '3672621': {
    listing_id: '3672621',
    account: 'dbcinema',
    items: [
      { item: 'Sony FX3', qty: 3 },
    ],
    included: ['9x NP-FZ100 batteries', '3x 256GB SD cards'],
    notes: '3x FX3 body kit. Only cameras + cards + batteries in photo.',
    photoFile: '/tmp/listing-images/3672621.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — SONY A7 BUNDLES
  // ═══════════════════════════════════════════════════════════

  '3737400': {
    listing_id: '3737400',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB Angelbird SD card'],
    notes: 'Photo shows A7S III body (α7S visible) but mapped to A7 III in inventory. GM lens (orange G). NO NPF 970, NO CF Express.',
    photoFile: '/tmp/listing-images/3737400.jpg',
  },

  '3733720': {
    listing_id: '3733720',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 3 },
      { item: 'Sony GM 24-70mm f2.8', qty: 3 },
    ],
    included: ['9x NP-FZ100 batteries', '3x 128GB SD cards'],
    notes: '3x A7III + 3x GM 24-70mm multi-cam set.',
    photoFile: '/tmp/listing-images/3733720.jpg',
  },

  '3733543': {
    listing_id: '3733543',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7III + GM 24-70mm bundle.',
    photoFile: '/tmp/listing-images/3733543.jpg',
  },

  '3733272': {
    listing_id: '3733272',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7SIII title but mapped to A7 III. + GM 24-70mm.',
    photoFile: '/tmp/listing-images/3733272.jpg',
  },

  '3731445': {
    listing_id: '3731445',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7III + GM 24-70mm.',
    photoFile: '/tmp/listing-images/3731445.jpg',
  },

  '3731615': {
    listing_id: '3731615',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7III + DJI RS3 Pro + GM 24-70mm bundle.',
    photoFile: '/tmp/listing-images/3731615.jpg',
  },

  '3718802': {
    listing_id: '3718802',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
      { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7III + DJI RS3 Pro + GM 16-35mm.',
    photoFile: '/tmp/listing-images/3718802.jpg',
  },

  '3733513': {
    listing_id: '3733513',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 III', qty: 1 },
      { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7III + GM 16-35mm.',
    photoFile: '/tmp/listing-images/3733513.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — SONY A7V BUNDLES
  // ═══════════════════════════════════════════════════════════

  '3735101': {
    listing_id: '3735101',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 V', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '256GB Lexar SD card'],
    notes: 'A7V + GM 24-70mm. Photo confirmed. CORRECT parsed_items.',
    photoFile: '/tmp/listing-images/3735101.jpg',
  },

  '3734916': {
    listing_id: '3734916',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 V', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7V body only.',
    photoFile: '/tmp/listing-images/3734916.jpg',
  },

  '3730318': {
    listing_id: '3730318',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 V', qty: 1 },
      { item: 'Sony GM 16-35mm f2.8', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7V + GM 16-35mm.',
    photoFile: '/tmp/listing-images/3730318.jpg',
  },

  '3733541': {
    listing_id: '3733541',
    account: 'dbcinema',
    items: [
      { item: 'Sony A7 V', qty: 1 },
      { item: 'Sony GM 24-70mm f2.8', qty: 1 },
      { item: 'Camera flash', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SD card'],
    notes: 'A7V + GM 24-70mm + flash bundle.',
    photoFile: '/tmp/listing-images/3733541.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — BLACKMAGIC CAMERAS
  // ═══════════════════════════════════════════════════════════

  '3732945': {
    listing_id: '3732945',
    account: 'dbcinema',
    items: [
      { item: 'BMPCC 6K Full Frame', qty: 1 },
      { item: 'Canon EF 24-105mm f4', qty: 1 },
      { item: 'DJI RS3 Pro gimbal', qty: 1 },
    ],
    included: ['5x LP-E6NH batteries', 'Samsung SSD', 'cage'],
    notes: 'BMPCC 6K FF + Canon 24-105mm + gimbal.',
    photoFile: '/tmp/listing-images/3732945.jpg',
  },

  '3731877': {
    listing_id: '3731877',
    account: 'dbcinema',
    items: [
      { item: 'BMPCC 6K Full Frame', qty: 1 },
    ],
    included: ['5x LP-E6NH batteries', '1TB Lexar CFexpress Type B card', 'cage'],
    notes: 'BMPCC 6K FF body only. Card is CFexpress Type B NOT Type A. Parsed_items had wrong card type.',
    photoFile: '/tmp/listing-images/3731877.jpg',
  },

  '3730218': {
    listing_id: '3730218',
    account: 'dbcinema',
    items: [
      { item: 'BMPCC 6K Pro', qty: 1 },
    ],
    included: ['5x LP-E6NH batteries', 'Samsung SSD', 'cage'],
    notes: 'BMPCC 6K Pro body only.',
    photoFile: '/tmp/listing-images/3730218.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — ARRI
  // ═══════════════════════════════════════════════════════════

  '3733471': {
    listing_id: '3733471',
    account: 'dbcinema',
    items: [
      { item: 'Arri Alexa Mini', qty: 1 },
      { item: 'RED 512GB media card', qty: 2 },
    ],
    included: ['Tilta baseplate/rig', 'EVF viewfinder', 'wooden handle'],
    notes: 'Arri Alexa Mini cinema rig. 2x RED 512GB cards visible. V-mount batteries not shown but needed for power.',
    photoFile: '/tmp/listing-images/3733471.jpg',
  },

  '3729131': {
    listing_id: '3729131',
    account: 'dbcinema',
    items: [
      { item: 'Arri Alexa Mini', qty: 1 },
      { item: 'RED 512GB media card', qty: 2 },
    ],
    included: ['Tilta baseplate/rig', 'EVF viewfinder', 'wooden handle'],
    notes: 'Same Arri Alexa Mini listing template.',
    photoFile: '/tmp/listing-images/3729131.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — FUJIFILM
  // ═══════════════════════════════════════════════════════════

  '3729162': {
    listing_id: '3729162',
    account: 'dbcinema',
    items: [
      { item: 'Fujifilm X-T5', qty: 1 },
      { item: 'Fujifilm XF 16-55mm f2.8', qty: 1 },
    ],
    included: ['3x NP-W235 batteries', '128GB SanDisk SD card'],
    notes: 'Photo clearly shows 16-55mm f2.8 lens despite title saying 18-55. Correctly mapped in parsed_items.',
    photoFile: '/tmp/listing-images/3729162.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — STANDALONE LENSES
  // ═══════════════════════════════════════════════════════════

  '3636675': {
    listing_id: '3636675',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 14mm f1.8', qty: 1 }],
    included: [],
    notes: 'GM 14mm prime lens standalone.',
    photoFile: '/tmp/listing-images/3636675.jpg',
  },

  '3731134': {
    listing_id: '3731134',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 14mm f1.8', qty: 1 }],
    included: [],
    notes: 'GM 14mm prime lens standalone.',
    photoFile: '/tmp/listing-images/3731134.jpg',
  },

  '3730825': {
    listing_id: '3730825',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 14mm f1.8', qty: 1 }],
    included: [],
    notes: 'GM 14mm prime lens standalone.',
    photoFile: '/tmp/listing-images/3730825.jpg',
  },

  '3730233': {
    listing_id: '3730233',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 14mm f1.8', qty: 1 }],
    included: [],
    notes: 'GM 14mm prime lens standalone.',
    photoFile: '/tmp/listing-images/3730233.jpg',
  },

  '3737121': {
    listing_id: '3737121',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 35mm f1.4', qty: 1 }],
    included: [],
    notes: 'GM 35mm prime lens standalone.',
    photoFile: '/tmp/listing-images/3737121.jpg',
  },

  '3730194': {
    listing_id: '3730194',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 16-35mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 16-35mm lens standalone.',
    photoFile: '/tmp/listing-images/3730194.jpg',
  },

  '3735630': {
    listing_id: '3735630',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 12-24mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 12-24mm ultra-wide lens standalone.',
    photoFile: '/tmp/listing-images/3735630.jpg',
  },

  '3733522': {
    listing_id: '3733522',
    account: 'dbcinema',
    items: [{ item: 'Sony GM 12-24mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 12-24mm ultra-wide lens standalone.',
    photoFile: '/tmp/listing-images/3733522.jpg',
  },

  '3734732': {
    listing_id: '3734732',
    account: 'dbcinema',
    items: [{ item: 'Canon RF 24-70mm f2.8', qty: 1 }],
    included: [],
    notes: 'Canon RF 24-70mm standalone.',
    photoFile: '/tmp/listing-images/3734732.jpg',
  },

  '3733111': {
    listing_id: '3733111',
    account: 'dbcinema',
    items: [{ item: 'Canon RF 24-70mm f2.8', qty: 1 }],
    included: [],
    notes: 'Canon RF 24-70mm standalone.',
    photoFile: '/tmp/listing-images/3733111.jpg',
  },

  '3733598': {
    listing_id: '3733598',
    account: 'dbcinema',
    items: [{ item: 'Sigma 14-24mm f2.8 DG DN', qty: 1 }],
    included: [],
    notes: 'Sigma 14-24mm ultra-wide standalone.',
    photoFile: '/tmp/listing-images/3733598.jpg',
  },

  '3732564': {
    listing_id: '3732564',
    account: 'dbcinema',
    items: [{ item: '7Artisans 7.5mm f2.8 Fisheye', qty: 1 }],
    included: [],
    notes: '7Artisans fisheye standalone.',
    photoFile: '/tmp/listing-images/3732564.jpg',
  },

  '3731179': {
    listing_id: '3731179',
    account: 'dbcinema',
    items: [{ item: '7Artisans 7.5mm f2.8 Fisheye', qty: 1 }],
    included: [],
    notes: '7Artisans fisheye standalone.',
    photoFile: '/tmp/listing-images/3731179.jpg',
  },

  '3731973': {
    listing_id: '3731973',
    account: 'dbcinema',
    items: [{ item: '8-15mm f2.8 Fisheye Zoom', qty: 1 }],
    included: [],
    notes: '8-15mm fisheye zoom standalone.',
    photoFile: '/tmp/listing-images/3731973.jpg',
  },

  '3731121': {
    listing_id: '3731121',
    account: 'dbcinema',
    items: [{ item: '8-15mm f2.8 Fisheye Zoom', qty: 1 }],
    included: [],
    notes: '8-15mm fisheye zoom standalone.',
    photoFile: '/tmp/listing-images/3731121.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — CINEMA LENSES (DZO)
  // ═══════════════════════════════════════════════════════════

  '3728683': {
    listing_id: '3728683',
    account: 'dbcinema',
    items: [
      { item: 'DZO ARLES Prime 25mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 50mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 75mm T1.4', qty: 1 },
      { item: 'PL to Sony E mount', qty: 1 },
      { item: 'PL to EF mount', qty: 1 },
      { item: 'PL to RF mount', qty: 1 },
      { item: 'PL to L mount', qty: 1 },
    ],
    included: [],
    notes: 'DZO ARLES 3-lens set with all PL mount adapters.',
    photoFile: '/tmp/listing-images/3728683.jpg',
  },

  '3727907': {
    listing_id: '3727907',
    account: 'dbcinema',
    items: [
      { item: 'DZO ARLES Prime 25mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 50mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 75mm T1.4', qty: 1 },
      { item: 'PL to Sony E mount', qty: 1 },
      { item: 'PL to EF mount', qty: 1 },
      { item: 'PL to RF mount', qty: 1 },
      { item: 'PL to L mount', qty: 1 },
    ],
    included: [],
    notes: 'Same DZO ARLES 3-lens set.',
    photoFile: '/tmp/listing-images/3727907.jpg',
  },

  '3729196': {
    listing_id: '3729196',
    account: 'dbcinema',
    items: [
      { item: 'DZO ARLES Prime 25mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 35mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 50mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 75mm T1.4', qty: 1 },
      { item: 'DZO ARLES Prime 100mm T1.4', qty: 1 },
      { item: 'PL to L mount', qty: 1 },
      { item: 'PL to RF mount', qty: 1 },
    ],
    included: [],
    notes: 'DZO ARLES 5-lens set.',
    photoFile: '/tmp/listing-images/3729196.jpg',
  },

  '3730356': {
    listing_id: '3730356',
    account: 'dbcinema',
    items: [{ item: 'DZO Vespid Prime 25mm T2.1', qty: 1 }],
    included: [],
    notes: 'DZO Vespid single lens.',
    photoFile: '/tmp/listing-images/3730356.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — LIGHTS
  // ═══════════════════════════════════════════════════════════

  '3718095': {
    listing_id: '3718095',
    account: 'dbcinema',
    items: [
      { item: 'Aputure Amaran 300c', qty: 1 },
      { item: 'Aputure Light Dome softbox', qty: 1 },
    ],
    included: ['light stand'],
    notes: 'Amaran 300c RGB + softbox. Photo confirmed correct.',
    photoFile: '/tmp/listing-images/3718095.jpg',
  },

  '3731304': {
    listing_id: '3731304',
    account: 'dbcinema',
    items: [
      { item: 'Aputure Amaran 300c', qty: 1 },
    ],
    included: ['light stand'],
    notes: 'Amaran 300c RGB standalone.',
    photoFile: '/tmp/listing-images/3731304.jpg',
  },

  '3734057': {
    listing_id: '3734057',
    account: 'dbcinema',
    items: [
      { item: 'Aputure 300D II', qty: 2 },
      { item: 'Aputure Light Dome softbox', qty: 2 },
    ],
    included: ['2x light stands'],
    notes: '2x Aputure 300D II + 2x softbox set.',
    photoFile: '/tmp/listing-images/3734057.jpg',
  },

  '3619059': {
    listing_id: '3619059',
    account: 'dbcinema',
    items: [
      { item: 'Nanlite Forza 60C', qty: 1 },
    ],
    included: ['light stand', 'projection mount'],
    notes: 'Nanlite 60C RGB with gobo/projection mount. Parsed items wrongly included Aputure 600d Pro and Small rig tripod.',
    photoFile: '/tmp/listing-images/3619059.jpg',
  },

  '3730510': {
    listing_id: '3730510',
    account: 'dbcinema',
    items: [
      { item: 'Ambitful RGB light tubes 2x set', qty: 1 },
    ],
    included: [],
    notes: 'Ambitful RGB tubes. Parsed items wrongly included Aputure 300D II.',
    photoFile: '/tmp/listing-images/3730510.jpg',
  },

  '3730444': {
    listing_id: '3730444',
    account: 'dbcinema',
    items: [{ item: 'Aputure MC Pro', qty: 1 }],
    included: [],
    notes: 'Aputure MC Pro pocket RGB light.',
    photoFile: '/tmp/listing-images/3730444.jpg',
  },

  '3733948': {
    listing_id: '3733948',
    account: 'dbcinema',
    items: [{ item: 'Aputure 600d Pro', qty: 1 }],
    included: ['light stand'],
    notes: 'Aputure 600d Pro. Parsed items were empty — needs this item.',
    photoFile: '/tmp/listing-images/3733948.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — AUDIO
  // ═══════════════════════════════════════════════════════════

  '3732464': {
    listing_id: '3732464',
    account: 'dbcinema',
    items: [{ item: 'Rode NTG5 Boom Mic Set', qty: 1 }],
    included: ['boom pole', 'wind shield'],
    notes: 'Rode NTG5 boom mic set.',
    photoFile: '/tmp/listing-images/3732464.jpg',
  },

  '3720884': {
    listing_id: '3720884',
    account: 'dbcinema',
    items: [{ item: 'Audio boom mic Sennheiser', qty: 1 }],
    included: ['boom pole', 'wind shield'],
    notes: 'Sennheiser MKE600 boom mic. Parsed items wrongly included Rode NTG5 as well.',
    photoFile: '/tmp/listing-images/3720884.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — DRONES
  // ═══════════════════════════════════════════════════════════

  '3732487': {
    listing_id: '3732487',
    account: 'dbcinema',
    items: [
      { item: 'DJI Mavic 4 Pro', qty: 1 },
      { item: 'ND filter', qty: 1 },
    ],
    included: ['3x DJI Intelligent Flight Batteries', 'DJI RC Pro controller', 'SanDisk 512GB microSD', 'shoulder bag'],
    notes: 'Mavic 4 Pro Fly More kit. NO RED 512GB media card — it is a SanDisk microSD. Drone flight batteries are NOT DJI gimbal batteries.',
    photoFile: '/tmp/listing-images/3732487.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — DJ/PARTY
  // ═══════════════════════════════════════════════════════════

  '3733054': {
    listing_id: '3733054',
    account: 'dbcinema',
    items: [{ item: 'DJ RX3 Pioneer controller', qty: 1 }],
    included: [],
    notes: 'Pioneer RX3 standalone.',
    photoFile: '/tmp/listing-images/3733054.jpg',
  },

  '3731394': {
    listing_id: '3731394',
    account: 'dbcinema',
    items: [{ item: 'DJ RX3 Pioneer controller', qty: 1 }],
    included: [],
    notes: 'Pioneer RX3 standalone.',
    photoFile: '/tmp/listing-images/3731394.jpg',
  },

  '3730107': {
    listing_id: '3730107',
    account: 'dbcinema',
    items: [{ item: 'DJ RX3 Pioneer controller', qty: 1 }],
    included: [],
    notes: 'Pioneer RX3 standalone.',
    photoFile: '/tmp/listing-images/3730107.jpg',
  },

  '3731591': {
    listing_id: '3731591',
    account: 'dbcinema',
    items: [{ item: 'Pioneer XDJ-RX2', qty: 1 }],
    included: [],
    notes: 'Pioneer XDJ-RX2 standalone.',
    photoFile: '/tmp/listing-images/3731591.jpg',
  },

  '3731272': {
    listing_id: '3731272',
    account: 'dbcinema',
    items: [{ item: 'Pioneer XDJ-RX2', qty: 1 }],
    included: [],
    notes: 'Pioneer XDJ-RX2 standalone.',
    photoFile: '/tmp/listing-images/3731272.jpg',
  },

  '3735486': {
    listing_id: '3735486',
    account: 'dbcinema',
    items: [
      { item: 'JBL Club 120 speaker', qty: 2 },
      { item: 'Pioneer XDJ-RX2', qty: 1 },
    ],
    included: [],
    notes: '2x JBL Club 120 + Pioneer RX2 DJ combo. Title says PartyBox but photo shows Club 120.',
    photoFile: '/tmp/listing-images/3735486.jpg',
  },

  '3734546': {
    listing_id: '3734546',
    account: 'dbcinema',
    items: [{ item: 'JBL Club 120 speaker', qty: 2 }],
    included: [],
    notes: '2x JBL Club 120 speakers.',
    photoFile: '/tmp/listing-images/3734546.jpg',
  },

  '3734912': {
    listing_id: '3734912',
    account: 'dbcinema',
    items: [{ item: 'JBL Club 120 speaker', qty: 1 }],
    included: [],
    notes: 'Single JBL Club 120 speaker.',
    photoFile: '/tmp/listing-images/3734912.jpg',
  },

  '3729588': {
    listing_id: '3729588',
    account: 'dbcinema',
    items: [{ item: 'JBL Club 120 speaker', qty: 2 }],
    included: [],
    notes: '2x JBL Club 120 speakers.',
    photoFile: '/tmp/listing-images/3729588.jpg',
  },

  '3729551': {
    listing_id: '3729551',
    account: 'dbcinema',
    items: [{ item: 'JBL Club 120 speaker', qty: 2 }],
    included: [],
    notes: '2x JBL Club 120 speakers.',
    photoFile: '/tmp/listing-images/3729551.jpg',
  },

  '3710030': {
    listing_id: '3710030',
    account: 'dbcinema',
    items: [{ item: 'JBL PartyBox 110', qty: 1 }],
    included: [],
    notes: 'JBL PartyBox 110 standalone.',
    photoFile: '/tmp/listing-images/3710030.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — PROJECTORS
  // ═══════════════════════════════════════════════════════════

  '3735519': {
    listing_id: '3735519',
    account: 'dbcinema',
    items: [{ item: 'ViewSonic 4K Projector', qty: 1 }],
    included: ['10m HDMI cable'],
    notes: 'ViewSonic 4K projector.',
    photoFile: '/tmp/listing-images/3735519.jpg',
  },

  '3733499': {
    listing_id: '3733499',
    account: 'dbcinema',
    items: [{ item: 'ViewSonic 4K Projector', qty: 1 }],
    included: ['10m HDMI cable'],
    notes: 'ViewSonic 4K projector.',
    photoFile: '/tmp/listing-images/3733499.jpg',
  },

  '3735640': {
    listing_id: '3735640',
    account: 'dbcinema',
    items: [
      { item: 'Anker Nebula Projector', qty: 1 },
      { item: 'Projection screen', qty: 1 },
    ],
    included: [],
    notes: 'Anker Nebula projector + screen bundle.',
    photoFile: '/tmp/listing-images/3735640.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — GOPRO & ACTION
  // ═══════════════════════════════════════════════════════════

  '3731569': {
    listing_id: '3731569',
    account: 'dbcinema',
    items: [
      { item: 'GoPro 12 Hero', qty: 1 },
      { item: 'Suction cups', qty: 1 },
    ],
    included: ['128GB SanDisk microSD'],
    notes: 'GoPro + suction mount. Parsed items wrongly had DJI Wireless Mics and 256GB card.',
    photoFile: '/tmp/listing-images/3731569.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // DB CINEMA — OTHER
  // ═══════════════════════════════════════════════════════════

  '3726901': {
    listing_id: '3726901',
    account: 'dbcinema',
    items: [{ item: 'Hollyland Pyro S transmitter', qty: 1 }],
    included: [],
    notes: 'Hollyland Pyro S wireless video transmitter/receiver.',
    photoFile: '/tmp/listing-images/3726901.jpg',
  },

  '3728465': {
    listing_id: '3728465',
    account: 'dbcinema',
    items: [],
    included: [],
    notes: 'Blackmagic Pyxis 6K — NOT in MASTER_INVENTORY. Parsed items were empty.',
    photoFile: '/tmp/listing-images/3728465.jpg',
  },

  '3732880': {
    listing_id: '3732880',
    account: 'dbcinema',
    items: [],
    included: [],
    notes: 'Sony FX30 (APS-C) — NOT in MASTER_INVENTORY. Camera + 24-70mm GM combo but FX30 body not tracked.',
    photoFile: '/tmp/listing-images/3732880.jpg',
  },

  '3722354': {
    listing_id: '3722354',
    account: 'dbcinema',
    items: [{ item: 'Sony 11mm f2.8 fisheye', qty: 1 }],
    included: [],
    notes: 'TTArtisan/Sony 11mm fisheye. Parsed items were empty — needs this item.',
    photoFile: '/tmp/listing-images/3722354.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — SONY FX3 BUNDLES
  // ═══════════════════════════════════════════════════════════

  '3736797': {
    listing_id: '3736797',
    account: 'leo',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony 28-70mm', qty: 1 },
    ],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'FX3 + 28-70mm (FE 3.5-5.6/28-70 clearly visible). NO gimbal, NO NPF 970.',
    photoFile: '/tmp/listing-images/3736797.jpg',
  },

  '3736782': {
    listing_id: '3736782',
    account: 'leo',
    items: [
      { item: 'Sony FX3', qty: 2 },
      { item: 'Sony GM 24-70mm f2.8', qty: 2 },
    ],
    included: ['4x NP-FZ100 batteries', '2x 128GB SanDisk SD cards', '2x XLR handles'],
    notes: '2x FX3 + 2x GM 24-70mm. NO NPF 970, NO V-mount, NO Hollyland in photo.',
    photoFile: '/tmp/listing-images/3736782.jpg',
  },

  '3733656': {
    listing_id: '3733656',
    account: 'leo',
    items: [
      { item: 'Sony FX3', qty: 2 },
      { item: 'Sony GM 24-70mm f2.8', qty: 2 },
    ],
    included: ['4x NP-FZ100 batteries', '2x 128GB SanDisk SD cards', '2x XLR handles'],
    notes: 'Same 2x FX3 + 2x GM template. NO extras.',
    photoFile: '/tmp/listing-images/3733656.jpg',
  },

  '3734666': {
    listing_id: '3734666',
    account: 'leo',
    items: [{ item: 'Sony FX3', qty: 1 }],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card'],
    notes: 'FX3 body only. NO NPF 970, NO CF Express.',
    photoFile: '/tmp/listing-images/3734666.jpg',
  },

  '3733267': {
    listing_id: '3733267',
    account: 'leo',
    items: [{ item: 'Sony FX3', qty: 1 }],
    included: ['3x NP-FZ100 batteries', '128GB SanDisk SD card'],
    notes: 'FX3 body only. Same template as 3734666.',
    photoFile: '/tmp/listing-images/3733267.jpg',
  },

  '3732568': {
    listing_id: '3732568',
    account: 'leo',
    items: [
      { item: 'Sony FX3', qty: 1 },
      { item: 'Sony 28-70mm', qty: 1 },
      { item: 'Rode Wireless Go II set', qty: 1 },
      { item: 'Sirui tripod', qty: 1 },
    ],
    included: ['2x NP-FZ100 batteries', '128GB SanDisk SD card', 'XLR handle'],
    notes: 'FX3 Interview Set. 28-70mm lens (no G badge). Rode Wireless Go II (2 TX + 2 lavs). Sirui tripod visible. NO Hollyland, NO Rode Video Mic Go, NO NPF 970.',
    photoFile: '/tmp/listing-images/3732568.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — SONY A7 BUNDLES
  // ═══════════════════════════════════════════════════════════

  '3733059': {
    listing_id: '3733059',
    account: 'leo',
    items: [
      { item: 'Sony A7 III', qty: 3 },
      { item: 'Sony 28-70mm', qty: 3 },
    ],
    included: ['6x NP-FZ100 batteries', '3x 128GB SanDisk SD cards'],
    notes: '3x A7III + 3x 28-70mm (no G badge, small lenses). NO NPF 970.',
    photoFile: '/tmp/listing-images/3733059.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — BLACKMAGIC
  // ═══════════════════════════════════════════════════════════

  '3731758': {
    listing_id: '3731758',
    account: 'leo',
    items: [
      { item: 'BMPCC 6K Pro', qty: 1 },
      { item: 'Canon EF 24-105mm f4', qty: 1 },
    ],
    included: ['6x LP-E6NH batteries', 'Samsung SSD', 'cage', 'hard case with cables'],
    notes: 'BMPCC 6K Pro + Canon 24-105mm. NO C-stand, NO NPF 970, NO V-mount in photo.',
    photoFile: '/tmp/listing-images/3731758.jpg',
  },

  '3737329': {
    listing_id: '3737329',
    account: 'leo',
    items: [
      { item: 'BMPCC 6K Full Frame', qty: 1 },
    ],
    included: ['cage', 'batteries', 'SSD'],
    notes: 'BMPCC 6K FF body set.',
    photoFile: '/tmp/listing-images/3737329.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — STANDALONE LENSES
  // ═══════════════════════════════════════════════════════════

  '3737415': {
    listing_id: '3737415',
    account: 'leo',
    items: [{ item: 'Sony GM 24-70mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 24-70mm standalone.',
    photoFile: '/tmp/listing-images/3737415.jpg',
  },

  '3736086': {
    listing_id: '3736086',
    account: 'leo',
    items: [{ item: 'Sony GM 70-200mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 70-200mm tele standalone.',
    photoFile: '/tmp/listing-images/3736086.jpg',
  },

  '3718262': {
    listing_id: '3718262',
    account: 'leo',
    items: [{ item: 'Sony GM 70-200mm f2.8', qty: 1 }],
    included: [],
    notes: 'GM 70-200mm tele standalone.',
    photoFile: '/tmp/listing-images/3718262.jpg',
  },

  '3734321': {
    listing_id: '3734321',
    account: 'leo',
    items: [{ item: 'Anamorphic Great Joy lens 35mm', qty: 1 }],
    included: [],
    notes: 'Great Joy 35mm anamorphic standalone.',
    photoFile: '/tmp/listing-images/3734321.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — CINEMA LENS SETS
  // ═══════════════════════════════════════════════════════════

  '3735587': {
    listing_id: '3735587',
    account: 'leo',
    items: [
      { item: 'DZO Vespid Prime 16mm T2.1', qty: 1 },
      { item: 'DZO Vespid Prime 25mm T2.1', qty: 1 },
      { item: 'DZO Vespid Prime 50mm T2.1', qty: 1 },
      { item: 'DZO Vespid Prime 75mm T2.1', qty: 1 },
      { item: 'DZO Vespid Prime 100mm T2.1', qty: 1 },
      { item: 'DZO Vespid Prime 125mm T2.1', qty: 1 },
    ],
    included: [],
    notes: 'Full 6-lens Vespid set. Parsed items also included BMPCC 6K Pro, Sony FX3, PL to Sony E mount — remove non-lens items if this is a lens-only listing.',
    photoFile: '/tmp/listing-images/3735587.jpg',
  },

  '3732830': {
    listing_id: '3732830',
    account: 'leo',
    items: [
      { item: 'Anamorphic Blazar Remus 45mm', qty: 1 },
      { item: 'Anamorphic Blazar Remus 65mm', qty: 1 },
      { item: 'Anamorphic Blazar Remus 100mm', qty: 1 },
    ],
    included: [],
    notes: 'Blazar Remus 3-lens anamorphic set.',
    photoFile: '/tmp/listing-images/3732830.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — AUDIO
  // ═══════════════════════════════════════════════════════════

  '3733905': {
    listing_id: '3733905',
    account: 'leo',
    items: [{ item: 'Rode Wireless Mic Pro set', qty: 2 }],
    included: ['charging case', 'carrying case', '2x lavalier mics'],
    notes: '2x Rode Wireless PRO sets (clearly "WIRELESS PRO" on units). Parsed items wrongly included Audio boom mic Sennheiser.',
    photoFile: '/tmp/listing-images/3733905.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — LIGHTS
  // ═══════════════════════════════════════════════════════════

  '3724604': {
    listing_id: '3724604',
    account: 'leo',
    items: [{ item: 'LED light panels RGB', qty: 3 }],
    included: ['3x light stands', '3x batteries', 'carrying case', 'cables'],
    notes: '3x GVM RGB LED panels. Parsed items wrongly had Sony GM 24-70mm, DJI gimbal battery, Sirui tripod — ALL wrong.',
    photoFile: '/tmp/listing-images/3724604.jpg',
  },

  '3733985': {
    listing_id: '3733985',
    account: 'leo',
    items: [
      { item: 'Nanlite 500B', qty: 1 },
    ],
    included: ['light stand'],
    notes: 'Nanlite 500B bi-color LED. Parsed items wrongly had C-stand, Small rig tripod, NPF 970.',
    photoFile: '/tmp/listing-images/3733985.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — DRONES
  // ═══════════════════════════════════════════════════════════

  '3734199': {
    listing_id: '3734199',
    account: 'leo',
    items: [
      { item: 'DJI Mavic 3 Pro', qty: 1 },
      { item: 'ND filter', qty: 1 },
    ],
    included: ['3x DJI Intelligent Flight Batteries', 'DJI RC Pro controller', 'Samsung 256GB microSD', 'shoulder bag'],
    notes: 'Mavic 3 Pro Cine Fly More kit. Drone batteries NOT DJI gimbal batteries. 256GB card is microSD not full-size.',
    photoFile: '/tmp/listing-images/3734199.jpg',
  },

  // ═══════════════════════════════════════════════════════════
  // LEO — DJ/PARTY
  // ═══════════════════════════════════════════════════════════

  '3735666': {
    listing_id: '3735666',
    account: 'leo',
    items: [{ item: 'DJ RX3 Pioneer controller', qty: 1 }],
    included: [],
    notes: 'Pioneer RX3 standalone.',
    photoFile: '/tmp/listing-images/3735666.jpg',
  },
};

/**
 * Get the verified items for a listing from photo analysis.
 * Returns null if listing hasn't been photo-analyzed.
 */
export function getVerifiedItems(listingId: string): ListingPhotoEntry | null {
  return LISTING_PHOTO_REFERENCE[listingId] || null;
}

/**
 * Resolver-tier shape: each resolved row carries item_name, qty, confidence, source.
 * Photo-ref tier is treated as high-confidence manual verification.
 */
export interface ResolvedItem {
  item_name: string;
  qty: number;
  confidence: number;
  source: 'photo_ref';
}

/**
 * Tier-2 lookup used by the listing-resolution pipeline.
 * Returns the manually verified item list for a listing, or null if not photo-analyzed.
 * Confidence is fixed at 1.0 because photo entries are human-verified.
 */
export function lookupPhotoReference(listingId: string): ResolvedItem[] | null {
  const entry = LISTING_PHOTO_REFERENCE[listingId];
  if (!entry) return null;
  if (!entry.items || entry.items.length === 0) return null;
  return entry.items.map(({ item, qty }) => ({
    item_name: item,
    qty,
    confidence: 1.0,
    source: 'photo_ref' as const,
  }));
}

