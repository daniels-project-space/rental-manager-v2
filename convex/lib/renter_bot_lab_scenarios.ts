/** Small, owner-grounded scenarios used by the isolated Renter Bot Lab. */
export const RENTER_BOT_LAB_SCENARIO_IDS = [
  "bmpcc-6k-full-frame-kit",
  "sony-fx3-batteries",
  "diogo-sony-fx3-kit",
  "verification-failed",
  "confirmed-booking",
] as const;

export type RenterBotLabScenarioId = (typeof RENTER_BOT_LAB_SCENARIO_IDS)[number];

export type RenterBotLabAccountSlug = "leo" | "dbcinema" | "diogo";

const RENTER_BOT_LAB_ACCOUNT_NAMES: Record<RenterBotLabAccountSlug, string> = {
  leo: "Leo",
  dbcinema: "DB Cinema",
  diogo: "Diogo",
};

export function renterBotLabAccountName(accountSlug: string): string {
  return RENTER_BOT_LAB_ACCOUNT_NAMES[accountSlug as RenterBotLabAccountSlug] ?? "Rental account";
}

/** Owner-confirmed pickup facts for isolated Lab conversations only. */
export const RENTER_BOT_LAB_PICKUP_POINTS = {
  diogo: {
    area: "Charing Cross Station area",
    address: "Next to Bus Stop H outside Charing Cross Station, London WC2N 5NG, England. Apple Maps: https://maps.apple/p/XXmY-sP81IyKyI",
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
  accountSlug: RenterBotLabAccountSlug;
  displayName: string;
  /** A final platform failure event, simulated entirely within the Lab. */
  startStage?: "verification_failed" | "confirmed";
  /** Seed a normal, pending rental request with a current future date range. */
  rentalSetup: { startInDays: number; durationDays: number };
  /** Exact physical inclusions confirmed for this listing, never the shared item. */
  ownerConfirmedKitContents?: { lines: string[]; source: string };
  item: ScenarioItem;
}

const BASE_SCENARIOS: RenterBotLabScenario[] = [
  {
    id: "bmpcc-6k-full-frame-kit",
    title: "Blackmagic 6K Full Frame kit",
    accountSlug: "dbcinema",
    displayName: "BMPCC 6K Full Frame Kit",
    rentalSetup: { startInDays: 14, durationDays: 1 },
    ownerConfirmedKitContents: {
      source: "Owner-confirmed Lab scenario for DB Cinema listing 1103089",
      lines: [
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
    ownerConfirmedKitContents: {
      source: "Owner-confirmed Lab scenario for Leo Sony FX3 camera kits",
      lines: [
        "3× Sony NP-FZ100 batteries",
        "1× 320GB CFexpress Type A card",
        "Sony dual battery charger",
      ],
    },
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
      card_type: "CFexpress Type A",
      compatibility: {
        batteries: ["Sony NP-FZ100"],
        cards: ["CFexpress Type A"],
        included_with_rental: ["3× Sony NP-FZ100 batteries", "1× 320GB CFexpress Type A card", "Sony dual battery charger"],
      },
      notes: "Owner-confirmed: each FX3 camera kit includes three Sony NP-FZ100 batteries, a dual charger, and a 320GB CFexpress card. At least 12 batteries are available across shared stock.",
    },
  },
];

const DIOGO_FX3_SCENARIO: RenterBotLabScenario = {
  id: "diogo-sony-fx3-kit",
  title: "Sony FX3 single-camera kit",
  accountSlug: "diogo",
  displayName: "Sony FX3 Full-Frame Cinema Camera",
  rentalSetup: { startInDays: 14, durationDays: 1 },
  item: {
    name_canonical: "Sony FX3",
    display_name: "Sony FX3",
    name_input: "Sony FX3 Full-Frame Cinema Camera",
    slug: "lab-diogo-fx3-kit",
    kind: "camera",
    sub_kind: "cinema_camera",
    qty: 1,
    unit_kind: "kit",
    battery_type: "Sony NP-FZ100",
    card_type: "CFexpress Type A",
    notes: "Diogo's single-camera listing includes one Sony FX3 Cinema Line camera, a 320GB Lexar CFexpress Type A card, camera cage, three NP-FZ100 batteries, protective carry case and charger. Only the proprietary charging cable is supplied; standard USB-C or USB 2.0 leads are not included. Some FX3 units are Asian-market models, so ask if the renter needs the UK/PAL selector and confirm which unit will be supplied. The listing describes 9am–10pm as a general availability window; agree an exact pickup and return time, and do not promise a full battery after a tight turnaround.",
    compatibility: {
      batteries: ["Sony NP-FZ100"],
      cards: ["CFexpress Type A"],
      included_with_rental: [
        "1× Sony FX3 Cinema Line camera",
        "1× 320GB Lexar CFexpress Type A card",
        "1× camera cage",
        "3× Sony NP-FZ100 batteries",
        "1× protective carrying case",
        "Sony charger (proprietary charging cable only)",
      ],
    },
  },
};

export const RENTER_BOT_LAB_SCENARIOS: RenterBotLabScenario[] = [
  ...BASE_SCENARIOS,
  DIOGO_FX3_SCENARIO,
  { ...BASE_SCENARIOS[0], id: "verification-failed", title: "Verification failed",
    startStage: "verification_failed" },
  { ...BASE_SCENARIOS[0], id: "confirmed-booking", title: "Confirmed booking and times",
    startStage: "confirmed" },
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
