/** Small, owner-grounded scenarios used by the isolated Renter Bot Lab. */
export const RENTER_BOT_LAB_SCENARIO_IDS = [
  "bmpcc-6k-full-frame-kit",
  "sony-28-70-lens-fit",
  "sony-fx3-batteries",
] as const;

export type RenterBotLabScenarioId = (typeof RENTER_BOT_LAB_SCENARIO_IDS)[number];

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
  item: ScenarioItem;
  summary: string;
  prompts: string[];
}

export const RENTER_BOT_LAB_SCENARIOS: RenterBotLabScenario[] = [
  {
    id: "bmpcc-6k-full-frame-kit",
    title: "Blackmagic 6K Full Frame kit",
    accountSlug: "dbcinema",
    displayName: "BMPCC 6K Full Frame Kit",
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
    summary: "Check that the bot names the confirmed card, batteries and kit accessories.",
    prompts: [
      "Hi, what exactly comes with the BMPCC 6K Full Frame kit, including the memory card and batteries?",
    ],
  },
  {
    id: "sony-28-70-lens-fit",
    title: "Sony 28–70mm lens fit",
    accountSlug: "leo",
    displayName: "Sony FE 28–70mm f/3.5–5.6 OSS",
    item: {
      name_canonical: "Sony FE 28–70mm f/3.5–5.6 OSS",
      display_name: "Sony FE 28–70mm f/3.5–5.6 OSS",
      name_input: "Sony FE 28–70mm f/3.5–5.6 OSS",
      slug: "lab-sony-fe-28-70mm-oss",
      kind: "lens",
      sub_kind: "zoom",
      qty: 2,
      unit_kind: "unit",
      lens_mount: "Sony E",
      notes: "Owner-confirmed autofocus lens. Its widest focal length is 28mm, so it does not cover 24mm.",
    },
    summary: "Check honest autofocus and focal-range matching before offering the lens.",
    prompts: [
      "I need an autofocus lens that starts at 24mm. Does this one cover that?",
      "28mm is okay for me. Could I use this lens then?",
    ],
  },
  {
    id: "sony-fx3-batteries",
    title: "Sony FX3 kit batteries",
    accountSlug: "leo",
    displayName: "Sony FX3 Camera Kit",
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
    summary: "Check the exact battery type and per-camera quantity from confirmed stock facts.",
    prompts: [
      "How many batteries come with the Sony FX3, and what type are they?",
    ],
  },
];

export function renterBotLabScenario(id: string): RenterBotLabScenario | undefined {
  return RENTER_BOT_LAB_SCENARIOS.find((scenario) => scenario.id === id);
}
