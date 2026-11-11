/**
 * Delivery weight + distance logic — ported from db-cinema-v2
 * (/home/ubuntu/db-cinema-v2/convex/delivery.ts + lib/taxonomy.ts).
 *
 * Used to: (a) estimate an item's weight/size when the inventory row doesn't
 * carry it, (b) classify an order's courier vehicle (bike/car/van), and
 * (c) measure straight-line distance (Haversine, km) from the main rental hub
 * to a listing's location — so a tile can flag gear that's too heavy to get to
 * a far pickup location. Pure functions, no Convex deps.
 */

export interface ItemSpec {
  weight_kg?: number | null;
  size_score?: number | null;
  kind?: string | null;
  item_type?: string | null;
  name?: string | null;
}

/** Fallback {sizeScore, weightKg} by RMv2 item.kind, mirroring db-cinema's
 *  DELIVERY_BY_TYPE table. Used only when the item row has no weight_kg. */
const KIND_SPEC: Record<string, { sizeScore: number; weightKg: number }> = {
  storage_card: { sizeScore: 1, weightKg: 0.1 },
  accessory: { sizeScore: 1, weightKg: 0.3 },
  transmission: { sizeScore: 1, weightKg: 0.5 },
  audio: { sizeScore: 2, weightKg: 1.0 },
  lens: { sizeScore: 2, weightKg: 1.0 },
  monitor: { sizeScore: 2, weightKg: 1.0 },
  video: { sizeScore: 2, weightKg: 1.0 },
  drone: { sizeScore: 2, weightKg: 1.5 },
  power: { sizeScore: 2, weightKg: 1.5 },
  camera: { sizeScore: 3, weightKg: 2.0 },
  gimbal: { sizeScore: 3, weightKg: 1.5 },
  stabilizer: { sizeScore: 3, weightKg: 1.5 },
  lighting: { sizeScore: 3, weightKg: 3.0 },
  grip: { sizeScore: 3, weightKg: 3.0 },
  support: { sizeScore: 3, weightKg: 3.0 },
  smoke_fx: { sizeScore: 3, weightKg: 4.0 },
  effects: { sizeScore: 3, weightKg: 4.0 },
  motion: { sizeScore: 3, weightKg: 4.0 },
  bundle: { sizeScore: 3, weightKg: 3.0 },
  dj_audio: { sizeScore: 4, weightKg: 8.0 },
};
const DEFAULT_SPEC = { sizeScore: 2, weightKg: 1.0 };

/** Resolve an item's effective {sizeScore, weightKg}: real inventory data wins,
 *  kind-based fallback otherwise. */
export function specForItem(it: ItemSpec): { sizeScore: number; weightKg: number } {
  const fallback = (it.kind && KIND_SPEC[it.kind]) || DEFAULT_SPEC;
  return {
    sizeScore: it.size_score != null && it.size_score > 0 ? it.size_score : fallback.sizeScore,
    weightKg: it.weight_kg != null && it.weight_kg > 0 ? it.weight_kg : fallback.weightKg,
  };
}

/** A single item is "heavy/bulky" — db-cinema's bigItem rule. */
export function isHeavyItem(it: ItemSpec): boolean {
  const s = specForItem(it);
  return s.sizeScore >= 4 || s.weightKg >= 5;
}

export type Vehicle = "motorcycle" | "car" | "van";

export interface OrderWeight {
  totalWeightKg: number;
  maxSizeScore: number;
  bigItems: number;
  vehicle: Vehicle;
  vehicleLabel: string;
  heaviestKg: number;
}

/** Classify the courier vehicle an order needs (db-cinema rule). */
export function classifyOrderWeight(items: Array<{ spec: ItemSpec; qty: number }>): OrderWeight {
  let totalWeightKg = 0;
  let totalScore = 0;
  let maxSizeScore = 1;
  let bigItems = 0;
  let heaviestKg = 0;
  for (const { spec, qty } of items) {
    const s = specForItem(spec);
    const n = Math.max(1, qty);
    totalWeightKg += s.weightKg * n;
    totalScore += s.sizeScore * n;
    if (s.sizeScore > maxSizeScore) maxSizeScore = s.sizeScore;
    if (s.weightKg > heaviestKg) heaviestKg = s.weightKg;
    if (s.sizeScore >= 4 || s.weightKg >= 5) bigItems += n;
  }
  let vehicle: Vehicle;
  if (bigItems >= 2 || totalWeightKg > 20 || totalScore >= 10) vehicle = "van";
  else if (maxSizeScore <= 2 && bigItems === 0 && totalWeightKg <= 8 && items.length <= 3)
    vehicle = "motorcycle";
  else vehicle = "car";
  const vehicleLabel =
    vehicle === "van" ? "Van" : vehicle === "car" ? "Car" : "Bike/tube";
  return { totalWeightKg, maxSizeScore, bigItems, vehicle, vehicleLabel, heaviestKg };
}

/**
 * DB Cinema checkout's delivery bands, applied to the selected rental basket.
 * Keep the bands, load interpolation, and round-trip margin aligned with
 * convex/delivery.ts in db-cinema-v2. The rental manager supplies the selected
 * account's origin and owner inventory specs; no model-provided item weights
 * or prices enter this calculation.
 */
const CHECKOUT_PRICING: Record<Vehicle, [number, number][]> = {
  motorcycle: [[15, 20], [20, 27], [28, 38], [35, 48], [42, 55], [50, 68]],
  car: [[21, 28], [28, 38], [39, 53], [49, 67], [59, 77], [70, 95]],
  van: [[45, 65], [55, 75], [70, 95], [80, 105], [90, 115], [105, 140]],
};
const CHECKOUT_ZONE_MAX_KM = [3, 5, 10, 15, 20, 30];
const CHECKOUT_LOAD_SPAN: Record<Vehicle, [number, number]> = {
  motorcycle: [1, 6],
  car: [3, 16],
  van: [8, 42],
};
const DEFAULT_DELIVERY_MARGIN_PCT = 10;

export type DeliveryPriceQuote =
  | {
      ok: true;
      fee: number;
      oneWay: number;
      vehicle: Vehicle;
      vehicleLabel: string;
      km: number;
      load: number;
      totalWeightKg: number;
    }
  | { ok: false; reason: "empty_basket" | "out_of_range" };

/** Exact weighted round-trip price calculation used by DB Cinema checkout. */
export function quoteDeliveryPrice(
  items: Array<{ spec: ItemSpec; qty: number }>,
  km: number,
  maxKm = 30,
  marginPct = DEFAULT_DELIVERY_MARGIN_PCT,
): DeliveryPriceQuote {
  if (!items.length) return { ok: false, reason: "empty_basket" };
  if (!Number.isFinite(km) || km < 0 || km > maxKm) {
    return { ok: false, reason: "out_of_range" };
  }

  let totalScore = 0;
  let totalWeightKg = 0;
  let maxScore = 1;
  let bigItems = 0;
  let hasDJ = false;
  let hasSpeaker = false;
  for (const { spec, qty } of items) {
    const resolved = specForItem(spec);
    const count = Math.max(1, Math.floor(qty));
    totalScore += resolved.sizeScore * count;
    totalWeightKg += resolved.weightKg * count;
    maxScore = Math.max(maxScore, resolved.sizeScore);
    if (resolved.sizeScore >= 4 || resolved.weightKg >= 5) bigItems += count;
    const itemType = (spec.item_type ?? "").toLowerCase();
    const name = (spec.name ?? "").toLowerCase();
    hasDJ ||= itemType === "dj-deck" || spec.kind === "dj_audio" || /\b(?:dj|cdj|xdj|ddj)\b/.test(name);
    hasSpeaker ||= itemType === "speaker" || /\b(?:speaker|subwoofer|pa system)\b/.test(name);
  }

  let vehicle: Vehicle;
  if (
    (hasDJ && hasSpeaker) ||
    bigItems >= 2 ||
    totalWeightKg > 20 ||
    totalScore >= 10
  ) {
    vehicle = "van";
  } else if (
    maxScore <= 2 &&
    bigItems === 0 &&
    totalWeightKg <= 8 &&
    // Match DB Cinema: the courier cutoff uses distinct basket lines/specs;
    // quantities affect weight and load separately.
    items.length <= 3
  ) {
    vehicle = "motorcycle";
  } else {
    vehicle = "car";
  }

  const zoneIndex = CHECKOUT_ZONE_MAX_KM.findIndex((zoneMax) => km <= zoneMax);
  if (zoneIndex < 0) return { ok: false, reason: "out_of_range" };
  const [low, high] = CHECKOUT_PRICING[vehicle][zoneIndex];
  const load = totalScore + totalWeightKg * 0.25;
  const [loadStart, loadEnd] = CHECKOUT_LOAD_SPAN[vehicle];
  const loadFactor = Math.max(0, Math.min(1, (load - loadStart) / (loadEnd - loadStart)));
  const oneWay = Math.round(low + (high - low) * loadFactor);
  const fee = Math.round(oneWay * 2 * (1 + marginPct / 100));
  const vehicleLabel =
    vehicle === "van" ? "Large van" : vehicle === "car" ? "Small car courier" : "Motorcycle courier";

  return {
    ok: true,
    fee,
    oneWay,
    vehicle,
    vehicleLabel,
    km: Math.round(km * 10) / 10,
    load: Math.round(load),
    totalWeightKg,
  };
}

/**
 * Heaviness from item NAMES — robust where inventory weight_kg is missing (most
 * rows). Matches the owner's real list: speakers, DJ decks, lights, power
 * stations, and multiple cameras/lights are too heavy to hand-carry far.
 */
export function nameHeavy(items: Array<{ name?: string | null; qty?: number | null }>): boolean {
  const names = items.map((i) => (i.name ?? "").toLowerCase());
  const text = names.join(" | ");
  if (
    /speaker|subwoofer|\bsub\b|\bpa system\b|\bamp\b|\bdj\b|cdj|xdj|ddj|\bdeck\b|controller|turntable|power station|ecoflow|delta pro|jackery|generator|\bhmi\b|fresnel|\bdolly\b|\bslider\b|c-?stand|light stand|wind machine|smoke machine|\bhaze|projector/i.test(
      text,
    )
  )
    return true;
  // Effective quantity: max of the qty field and a leading "Nx" in the name
  // ("3x Sony FX3" as one line item → 3, not 1).
  const qtyOf = (i: { name?: string | null; qty?: number | null }) => {
    const m = (i.name ?? "").match(/(?:^|\b)(\d{1,2})\s?x\b/i);
    return Math.max(i.qty ?? 1, m ? parseInt(m[1]) : 1, 1);
  };
  const count = (re: RegExp) =>
    items.reduce((s, i) => (re.test((i.name ?? "").toLowerCase()) ? s + qtyOf(i) : s), 0);
  // multiple cameras
  if (
    count(
      /camera|\bfx3\b|\bfx6\b|\bfx30\b|\ba7\b|a7s|a7r|a7 |a7v|a7iii|a7iv|bmpcc|blackmagic|\br5\b|\br6\b|c70|c300|komodo|\bgh\d|lumix|eos|nikon z|cinema/i,
    ) >= 2
  )
    return true;
  // multiple lights
  if (count(/light|led|aputure|godox|nanlite|amaran|forza|tube light|softbox/i) >= 2) return true;
  return false;
}

/** Straight-line distance in km (Haversine). */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Decide whether an order is "too heavy to carry to this location" from the hub.
 * Anything past ~500m from the hub (Trafalgar Square) is too far to hand-carry a
 * heavy load — speakers, DJ decks, lights, multiple cameras, etc. So:
 *   heavyMaxKm = 0.5  (carry limit for a heavy load)
 *   maxKm      = 30   (absolute range)
 * "Heavy" = anything beyond a bike/tube load: needs a car/van, or >6kg total, or
 * any bulky/≥5kg item (a lone camera+lens stays light).
 */
export function tooHeavyForLocation(
  order: OrderWeight,
  distanceKm: number | null,
  heavyMaxKm = 0.5,
  maxKm = 30,
): { tooHeavy: boolean; outOfRange: boolean } {
  if (distanceKm == null) return { tooHeavy: false, outOfRange: false };
  const outOfRange = distanceKm > maxKm;
  const heavy =
    order.vehicle !== "motorcycle" ||
    order.totalWeightKg > 6 ||
    order.bigItems > 0 ||
    order.heaviestKg >= 5;
  const tooHeavy = heavy && distanceKm > heavyMaxKm;
  return { tooHeavy, outOfRange };
}
