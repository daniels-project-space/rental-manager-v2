/** Small, owner-grounded scenarios used by the isolated Renter Bot Lab. */
export const RENTER_BOT_LAB_SCENARIO_IDS = [
  "bmpcc-6k-full-frame-kit",
  "sony-fx3-batteries",
] as const;

export type RenterBotLabScenarioId = (typeof RENTER_BOT_LAB_SCENARIO_IDS)[number];

/** Owner-confirmed pickup facts for isolated Lab conversations only. */
export const RENTER_BOT_LAB_PICKUP_POINTS = {
  diogo: {
    area: "Charing Cross Station area",
    address: "Next to bus stop H outside Charing Cross Station, London WC2N 5NG. Apple Maps: https://maps.apple/p/XXmY-sP81IyKyI",
  },
  leo: {
    area: "Trafalgar Square area",
    address: "Outside the Waterstones bookstore at The Grand Building, Trafalgar Square, London WC2N 5EJ, England.",
  },
  dbcinema: {
    area: "Northumberland Street area",
    address: "10 Northumberland Street, London WC2N 5DB, England, outside the Sherlock Holmes pub.",
  },
} as const;

export function renterBotLabPickupPoint(accountSlug: string) {
  return RENTER_BOT_LAB_PICKUP_POINTS[accountSlug as keyof typeof RENTER_BOT_LAB_PICKUP_POINTS];
}

interface ScenarioItem {
  name_canonical: string;
  display_name: string;
  name_input: string;
  slug: string;
  kind: string;
  sub_kind?: string;
  qty: number;
  unit_kind: string;
  lens_mount?: string;
  battery_type?: string;
  card_type?: string;
  notes?: string;
  compatibility?: {
    batteries?: string[];
    cards?: string[];
    lenses?: string[];
    accessories?: string[];
    included_with_rental?: string[];
  };
}

export interface RenterBotLabScenario {
  id: RenterBotLabScenarioId;
  title: string;
  accountSlug: "leo" | "dbcinema";
  displayName: string;
  /** Seed a normal, pending rental request with a current future date range. */
  rentalSetup: { startInDays: number; durationDays: number };
  item: ScenarioItem;
}

export const RENTER_BOT_LAB_SCENARIOS: RenterBotLabScenario[] = [
  {
    id: "bmpcc-6k-full-frame-kit",
    title: "Blackmagic 6K Full Frame kit",
    accountSlug: "dbcinema",
    displayName: "BMPCC 6K Full Frame Kit",
    rentalSetup: { startInDays: 14, durationDays: 1 },
    item: {
      name_canonical: "BMPCC 6K Full Frame",
      display_name: "BMPCC 6K Full Frame Kit",
      name_input: "BMPCC 6K Full Frame Kit",
      slug: "lab-bmpcc-6k-full-frame-kit",
      kind: "camera",
      sub_kind: "cinema_camera",
      qty: 1,
      unit_kind: "kit",
      notes: "Owner-confirmed kit contents. The body takes native NP-F570 batteries.",
      battery_type: "NP-F570",
      card_type: "CFexpress Type B",
      compatibility: {
        batteries: ["NP-F570"],
        cards: ["CFexpress Type B"],
        included_with_rental: [
          "5× NP-F570 batteries",
          "1× Lexar Professional 1TB CFexpress Type B card",
          "Tilta cage",
          "Variable ND filter",
          "BMPCC charger",
          "Lens mount cap",
          "Carry case",
          "1× EF-to-L mount adapter",
        ],
      },
    },
  },
  {
    id: "sony-fx3-batteries",
    title: "Sony FX3 kit batteries",
    accountSlug: "leo",
    displayName: "Sony FX3 Camera Kit",
    rentalSetup: { startInDays: 14, durationDays: 1 },
    item: {
      name_canonical: "Sony FX3",
      display_name: "Sony FX3 Camera Kit",
      name_input: "Sony FX3 Camera Kit",
      slug: "lab-sony-fx3-camera-kit",
      kind: "camera",
      sub_kind: "cinema_camera",
      qty: 4,
      unit_kind: "kit",
      battery_type: "Sony NP-FZ100",
      compatibility: {
        batteries: ["Sony NP-FZ100"],
        included_with_rental: ["3× Sony NP-FZ100 batteries"],
      },
      notes: "Owner-confirmed: each FX3 camera kit includes three Sony NP-FZ100 batteries. At least 12 batteries are available across shared stock.",
    },
  },
];

export function renterBotLabScenario(id: string): RenterBotLabScenario | undefined {
  return RENTER_BOT_LAB_SCENARIOS.find((scenario) => scenario.id === id);
}

export function renterBotLabRentalDates(
  scenario: RenterBotLabScenario,
  today = new Date(),
): { startDate: string; endDate: string } {
  const start = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + scenario.rentalSetup.startInDays,
  ));
  const end = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate() + Math.max(0, scenario.rentalSetup.durationDays - 1),
  ));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
