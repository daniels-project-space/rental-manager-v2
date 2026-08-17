"use client";

import { useState } from "react";

export interface FixtureOption {
  _id: string;
  name: string;
  account_slug: string;
  scenario_type: string;
  description?: string;
  seed_context?: { items?: string[]; price_gbp?: number; dates?: string };
}

function scenarioLabel(scenario_type: string): string {
  return scenario_type.replace(/_/g, " ");
}

export interface CustomScenarioInput {
  items: string[];
  priceGbp?: number;
  dates?: string;
  location?: string;
}

// dbcinema_web excluded entirely per Daniel, 2026-08-17 ("not include DB
// cinema web" — not just reorder, actually leave it out of the list).
const ACCOUNTS = [
  { slug: "leo", label: "Leo" },
  { slug: "diogo", label: "Diogo" },
];

// Groups the ported V1 scenario_types into categories instead of one flat,
// unordered list (Daniel, 2026-08-17). Anything with a scenario_type not
// listed here still shows up, under "Other".
const SCENARIO_CATEGORIES: { label: string; types: string[] }[] = [
  {
    label: "Booking & Availability",
    types: [
      "availability_check",
      "same_day_rental",
      "pickup_times",
      "delivery_inquiry",
    ],
  },
  {
    label: "Pricing & Negotiation",
    types: ["price_negotiation", "student_budget", "accessory_upsell"],
  },
  {
    label: "Item & Project Questions",
    types: [
      "technical_questions",
      "multi_item",
      "commercial_production",
      "weekend_warrior",
    ],
  },
  {
    label: "Changes & Problems",
    types: ["cancel_reschedule", "late_return", "damage_insurance", "complaint"],
  },
  {
    label: "Rule & Security Probes",
    types: ["scam_probe", "info_probe", "cross_account"],
  },
  {
    label: "Other",
    types: ["returning_renter", "vague_inquiry"],
  },
];

export function ScenarioPicker({
  fixtures,
  disabled,
  startSession,
}: {
  fixtures: FixtureOption[] | undefined;
  disabled: boolean;
  startSession: (
    accountSlug: string,
    fixtureId?: string,
    custom?: CustomScenarioInput,
  ) => void;
}) {
  const [accountSlug, setAccountSlug] = useState(ACCOUNTS[0].slug);
  const [fixtureId, setFixtureId] = useState<string>("");
  const [customItems, setCustomItems] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customDates, setCustomDates] = useState("");
  const [customLocation, setCustomLocation] = useState("");

  const list = fixtures ?? [];
  const byType = new Map<string, FixtureOption[]>();
  for (const f of list) {
    const arr = byType.get(f.scenario_type) ?? [];
    arr.push(f);
    byType.set(f.scenario_type, arr);
  }
  const knownTypes = new Set(SCENARIO_CATEGORIES.flatMap((c) => c.types));
  const groups = [
    ...SCENARIO_CATEGORIES.map((cat) => ({
      label: cat.label,
      options: cat.types.flatMap((t) => byType.get(t) ?? []),
    })),
    {
      label: "Other",
      options: list.filter((f) => !knownTypes.has(f.scenario_type)),
    },
  ].filter((g) => g.options.length > 0);

  function handleStart() {
    if (fixtureId) {
      startSession(accountSlug, fixtureId);
      return;
    }
    startSession(accountSlug, undefined, {
      items: customItems
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      priceGbp: customPrice ? Number(customPrice) : undefined,
      dates: customDates || undefined,
      location: customLocation || undefined,
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-[#8b8fa3]">
          Account / persona
        </label>
        <select
          value={accountSlug}
          onChange={(e) => setAccountSlug(e.target.value)}
          disabled={disabled}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
        >
          {ACCOUNTS.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#8b8fa3]">
          Scenario preset
        </label>
        <select
          value={fixtureId}
          onChange={(e) => setFixtureId(e.target.value)}
          disabled={disabled}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
        >
          <option value="">— Custom scenario (below) —</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((f) => {
                const item = f.seed_context?.items?.[0];
                return (
                  <option key={f._id} value={f._id}>
                    {scenarioLabel(f.scenario_type)}
                    {item ? ` — ${item}` : ""} ({f.account_slug})
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
        {!fixtures && (
          <p className="mt-1 text-xs text-[#8b8fa3]">Loading scenarios…</p>
        )}
      </div>

      {!fixtureId && (
        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-[#8b8fa3]">
            Custom scenario base info
          </p>
          <input
            value={customItems}
            onChange={(e) => setCustomItems(e.target.value)}
            disabled={disabled}
            placeholder="Items, comma-separated"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
          <input
            value={customPrice}
            onChange={(e) => setCustomPrice(e.target.value)}
            disabled={disabled}
            placeholder="Price £/day (optional)"
            inputMode="decimal"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
          <input
            value={customDates}
            onChange={(e) => setCustomDates(e.target.value)}
            disabled={disabled}
            placeholder="Time period, e.g. Aug 20-22 (optional)"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
          <input
            value={customLocation}
            onChange={(e) => setCustomLocation(e.target.value)}
            disabled={disabled}
            placeholder="Location (optional)"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={disabled}
        className="w-full rounded-md bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
      >
        Start test conversation
      </button>
    </div>
  );
}
