"use client";

import { useState } from "react";

export interface FixtureOption {
  _id: string;
  name: string;
  account_slug: string;
  scenario_type: string;
  description?: string;
}

const ACCOUNTS = [
  { slug: "dbcinema_web", label: "Daniel (DB Cinema)" },
  { slug: "leo", label: "Leo" },
  { slug: "diogo", label: "Diogo" },
];

export function ScenarioPicker({
  fixtures,
  disabled,
  startSession,
}: {
  fixtures: FixtureOption[] | undefined;
  disabled: boolean;
  startSession: (accountSlug: string, fixtureId?: string) => void;
}) {
  const [accountSlug, setAccountSlug] = useState(ACCOUNTS[0].slug);
  const [fixtureId, setFixtureId] = useState<string>("");
  const [customLocation, setCustomLocation] = useState("");
  const [customItems, setCustomItems] = useState("");
  const [customPrice, setCustomPrice] = useState("");

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
          {(fixtures ?? []).map((f) => (
            <option key={f._id} value={f._id}>
              {f.scenario_type} · {f.account_slug}
            </option>
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
            value={customLocation}
            onChange={(e) => setCustomLocation(e.target.value)}
            disabled={disabled}
            placeholder="Location (e.g. Trafalgar Square)"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
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
            placeholder="Price £ (optional)"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-[#e4e6eb] disabled:opacity-50"
          />
        </div>
      )}

      <button
        onClick={() => startSession(accountSlug, fixtureId || undefined)}
        disabled={disabled}
        className="w-full rounded-md bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
      >
        Start test conversation
      </button>
      <p className="text-[11px] leading-snug text-[#8b8fa3]">
        Note: custom location/price aren&apos;t wired into the seeded
        conversation context yet — this build only threads through the
        items list. Location/price context is a follow-up.
      </p>
    </div>
  );
}
