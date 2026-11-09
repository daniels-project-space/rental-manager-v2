"use client";

import { useState } from "react";
import { LAB_LIFECYCLES, type LabLifecycle } from "../../../../convex/lib/lab_lifecycle";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface FixtureOption {
  _id: string;
  name: string;
  account_slug: string;
  scenario_type: string;
  description?: string;
  source?: string;
  message_count?: number;
  seed_context?: {
    items?: string[];
    product_id?: number;
    price_gbp?: number;
    dates?: string;
    start_date?: string;
    end_date?: string;
    location?: string;
  };
}

function scenarioLabel(scenario_type: string): string {
  return scenario_type.replace(/_/g, " ");
}

export interface CustomScenarioInput {
  items?: string[];
  lifecycle?: LabLifecycle;
  /** Real Hygglo listing id — its price is what the renter pays. */
  productId?: number;
  priceGbp?: number;
  startDate?: string;
  endDate?: string;
  location?: string;
}

// The Lab must cover each renter-facing account, while dbcinema_web remains
// excluded per Daniel, 2026-08-17 ("not include DB cinema web").
const ACCOUNTS = [
  { slug: "leo", label: "Leo" },
  { slug: "diogo", label: "Diogo" },
  { slug: "dbcinema", label: "DB Cinema" },
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
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const [customItems, setCustomItems] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customStartDate, setCustomStartDate] = useState(inThreeDays);
  const [customEndDate, setCustomEndDate] = useState(inFiveDays);
  const [presetStartDateOverride, setPresetStartDateOverride] = useState("");
  const [presetEndDateOverride, setPresetEndDateOverride] = useState("");
  const [customLocation, setCustomLocation] = useState("");
  const [productId, setProductId] = useState("");
  const [lifecycle, setLifecycle] = useState<LabLifecycle>("inquiry");
  // Real listings for the chosen account, so a scenario can be based on what a
  // renter actually sees and pays.
  const listings = useQuery(api.online_listings.list, { account_slug: accountSlug });

  const list = (fixtures ?? []).filter((fixture) => fixture.account_slug === accountSlug);
  const selectedFixture = list.find((fixture) => fixture._id === fixtureId);
  const selectedListing = selectedFixture?.seed_context?.product_id != null
    ? listings?.find((listing) => listing.product_id === selectedFixture.seed_context?.product_id)
    : undefined;
  const selectedFixtureListingReady = selectedFixture?.source !== "v1_scenario_port" ||
    (selectedFixture.seed_context?.product_id != null && selectedListing != null);
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
      if (Boolean(presetStartDateOverride) !== Boolean(presetEndDateOverride)) return;
      startSession(accountSlug, fixtureId, {
        lifecycle,
        ...(presetStartDateOverride && presetEndDateOverride
          ? { startDate: presetStartDateOverride, endDate: presetEndDateOverride }
          : {}),
      });
      return;
    }
    const chosen = listings?.find((l) => String(l.product_id) === productId);
    startSession(accountSlug, undefined, {
      // A real listing wins over the free-text items box: on Hygglo the renter
      // is looking at ONE listing and pays ITS price, so basing the scenario on
      // a listing is the only way the price shown is the price they'd pay.
      productId: chosen ? chosen.product_id : undefined,
      lifecycle,
      items: chosen
        ? [chosen.name]
        : customItems
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
      priceGbp: chosen?.daily_price ?? (customPrice ? Number(customPrice) : undefined),
      startDate: customStartDate || undefined,
      endDate: customEndDate || undefined,
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
          onChange={(e) => {
            setAccountSlug(e.target.value);
            setFixtureId("");
            setProductId("");
            setPresetStartDateOverride("");
            setPresetEndDateOverride("");
          }}
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
          onChange={(e) => {
            setFixtureId(e.target.value);
            setPresetStartDateOverride("");
            setPresetEndDateOverride("");
          }}
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
        {fixtures && list.length === 0 && (
          <p className="mt-1 text-xs text-[#8b8fa3]">No saved examples for this account yet. You can start a custom scenario below.</p>
        )}
        {selectedFixture && (
          <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2 text-[11px] text-[#b6bac7]" role="note">
            <p>{selectedFixture.description || "Saved renter conversation preset."}</p>
            <p className="mt-1 text-[#8b8fa3]">
              {selectedFixture.source === "v1_scenario_port"
                ? `Example script: ${selectedFixture.message_count ?? 0} renter turn(s), sent one at a time.`
                : `Conversation history loaded into the AI: ${selectedFixture.message_count ?? 0} message(s).`}
              {" "}
              Seed context:
              {selectedFixture.seed_context?.items?.length ? ` · ${selectedFixture.seed_context.items.join(", ")}` : ""}
              {selectedFixture.seed_context?.start_date && selectedFixture.seed_context?.end_date
                ? ` · ${selectedFixture.seed_context.start_date}–${selectedFixture.seed_context.end_date}`
                : selectedFixture.seed_context?.dates ? ` · ${selectedFixture.seed_context.dates}` : ""}
              {selectedFixture.seed_context?.location ? ` · ${selectedFixture.seed_context.location}` : ""}
              {selectedFixture.seed_context?.price_gbp != null ? ` · £${selectedFixture.seed_context.price_gbp}/day` : ""}
            </p>
            {selectedFixture.seed_context?.product_id != null && (
              <p className="mt-1 text-[#8b8fa3]">
                {selectedListing
                  ? `Linked live listing: ${selectedListing.name} · #${selectedListing.product_id}${selectedListing.daily_price != null ? ` · £${selectedListing.daily_price}/day` : " · price needs confirmation"}`
                  : listings === undefined
                    ? "Checking the linked listing…"
                    : `Linked listing #${selectedFixture.seed_context.product_id} is not currently published on this account.`}
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#8b8fa3]">Simulation stage</label>
        <select disabled={disabled} value={lifecycle} onChange={e => setLifecycle(e.target.value as LabLifecycle)} className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm text-[#e4e6eb]">
          {LAB_LIFECYCLES.map(state => <option key={state} value={state}>{state.replace(/_/g, " ")}</option>)}
        </select>
        <p className="mt-1 text-[11px] text-[#8b8fa3]">Uses isolated booking facts. Choose the state matching the scenario; presets do not confirm a booking by themselves.</p>
        {fixtureId && <>
          <p className="mt-2 text-[11px] text-[#8b8fa3]">The saved conversation and dates are kept by default. Set both dates only if you want to override them.</p>
          <div className="mt-2 flex gap-2">
            <label className="text-[11px] text-[#8b8fa3]">Override pickup<input type="date" disabled={disabled} value={presetStartDateOverride} onChange={e => setPresetStartDateOverride(e.target.value)} className="block w-full rounded bg-black/30 px-2 py-1" /></label>
            <label className="text-[11px] text-[#8b8fa3]">Override return<input type="date" disabled={disabled} value={presetEndDateOverride} min={presetStartDateOverride || undefined} onChange={e => setPresetEndDateOverride(e.target.value)} className="block w-full rounded bg-black/30 px-2 py-1" /></label>
          </div>
          {Boolean(presetStartDateOverride) !== Boolean(presetEndDateOverride) && (
            <p className="mt-1 text-xs text-amber-300" role="alert">Choose both dates to override the preset dates.</p>
          )}
        </>}
      </div>

      {!fixtureId && (
        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-[#8b8fa3]">
            Custom scenario base info
          </p>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          >
            <option value="">
              — Base on a real Hygglo listing (recommended) —
            </option>
            {(listings ?? []).map((l) => (
              <option key={l.product_id} value={String(l.product_id)}>
                {l.daily_price != null ? `£${l.daily_price}/day — ` : ""}
                {l.display_name}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-[#8b8fa3]">
            Listing price = what the renter actually pays on Hygglo. The same
            camera appears at very different prices depending on the set, so
            basing a scenario on an item name quotes the cheapest body-only
            rate instead.
          </p>
          <input
            value={customItems}
            onChange={(e) => setCustomItems(e.target.value)}
            disabled={disabled}
            placeholder="…or items, comma-separated (ignored if a listing is picked)"
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
          <div className="flex gap-2">
            <label className="flex-1 text-[11px] text-[#8b8fa3]">
              Pickup
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                disabled={disabled}
                className="mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
              />
            </label>
            <label className="flex-1 text-[11px] text-[#8b8fa3]">
              Return
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                disabled={disabled}
                min={customStartDate}
                className="mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
              />
            </label>
          </div>
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
        disabled={disabled || !selectedFixtureListingReady || (Boolean(presetStartDateOverride) !== Boolean(presetEndDateOverride))}
        className="w-full rounded-md bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
      >
        Start test conversation
      </button>
    </div>
  );
}
