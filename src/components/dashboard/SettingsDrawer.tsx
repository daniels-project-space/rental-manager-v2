"use client";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import {
  PANEL_WIDGETS,
  STAT_WIDGETS,
} from "@/lib/dashboard/widget-registry";

const INPUT_STYLE = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#e4e6eb",
} as const;

interface LockedToggleProps {
  label: string;
  value: boolean;
  dangerOn?: boolean;
  dangerOff?: boolean;
  warning: string;
  tooltip: string;
  onConfirmedChange: (next: boolean) => void;
}

function LockedToggle({
  label,
  value,
  dangerOff,
  dangerOn,
  warning,
  tooltip,
  onConfirmedChange,
}: LockedToggleProps) {
  function handleClick() {
    const next = !value;
    const isDangerous = (next === false && dangerOff) || (next === true && dangerOn);
    if (isDangerous) {
      const ok = window.confirm(warning);
      if (!ok) return;
    }
    onConfirmedChange(next);
  }

  const isActive = value;
  const color = isActive ? "#22c55e" : "#8b8fa3";

  return (
    <div
      className="flex items-center justify-between py-3"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="min-w-0 mr-3">
        <p className="text-sm text-[#e4e6eb]">{label}</p>
        <p className="text-xs mt-0.5" style={{ color: "#8b8fa3" }} title={tooltip}>
          {tooltip}
        </p>
      </div>
      <button
        onClick={handleClick}
        className="flex-shrink-0 relative inline-flex items-center rounded-full transition-colors"
        style={{
          width: 40,
          height: 22,
          background: isActive ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)",
          border: "1px solid " + color,
        }}
        aria-pressed={isActive}
      >
        <span
          className="absolute rounded-full transition-transform"
          style={{
            width: 16,
            height: 16,
            background: color,
            left: 2,
            transform: isActive ? "translateX(18px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}

/**
 * Per-account "hard truths" editor — the ground-truth block injected verbatim at
 * the end of every AI draft for that account. Each account gets its own textarea
 * with a Save button that appears only when there are unsaved edits.
 */
function HardTruthsEditor() {
  const accounts = useQuery(api.settings.listAccountHardTruths);
  const save = useMutation(api.settings.setAccountHardTruths);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  if (!accounts) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">AI ground truth (hard truths)</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Account-specific facts the AI must always respect — injected at the end of
        every draft (e.g. included-free accessories, battery families, gear you do
        / don&apos;t own). Never shown to renters.
      </p>
      <div className="space-y-3">
        {accounts.map((a) => {
          const id = String(a.account_id);
          const value = drafts[id] ?? a.hard_truths;
          const dirty = value !== a.hard_truths;
          return (
            <div key={id}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-[#cbd5e1]">
                  {a.display_name}
                </span>
                {dirty ? (
                  <button
                    disabled={savingId === id}
                    onClick={async () => {
                      setSavingId(id);
                      setSavedId(null);
                      try {
                        await save({ account_id: a.account_id, hard_truths: value });
                        setSavedId(id);
                      } finally {
                        setSavingId(null);
                      }
                    }}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50"
                  >
                    {savingId === id ? "Saving…" : "Save"}
                  </button>
                ) : savedId === id ? (
                  <span className="text-[11px] text-green-400">Saved</span>
                ) : null}
              </div>
              <textarea
                value={value}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [id]: e.target.value }))
                }
                rows={4}
                placeholder="e.g. SD cards & batteries are included free; only suggest gear I actually own…"
                className="w-full resize-y rounded-lg px-2.5 py-2 text-[13px]"
                style={INPUT_STYLE}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Main rental hub editor — type a UK postcode, confirm it against postcodes.io
 * (the address register), and store the hub coords. Tile distance + the
 * too-heavy tag are measured from here. Also sets the heavy/max travel ranges.
 */
function HubEditor() {
  const settings = useQuery(api.settings.get);
  const setHub = useAction(api.settings.setHub);
  const update = useMutation(api.settings.update);
  const [pc, setPc] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!settings) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">Main rental hub</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Where your gear lives. Distance to each chat&apos;s pickup location and the
        &ldquo;too heavy&rdquo; tag are measured from here. Enter a UK postcode — we
        confirm it against the address register.
      </p>
      {settings.hub_label && (
        <div className="mb-2 inline-flex items-center gap-1.5 text-[12px] text-emerald-300 bg-emerald-500/[0.08] border border-emerald-400/25 rounded-lg px-2 py-1">
          📍 {settings.hub_label} · {settings.hub_postcode}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={pc}
          onChange={(e) => setPc(e.target.value)}
          placeholder={settings.hub_postcode ?? "e.g. WC2H 7ER"}
          className="text-sm rounded-lg px-2.5 py-1.5 flex-1 min-w-0"
          style={INPUT_STYLE}
        />
        <button
          disabled={busy || pc.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await setHub({ postcode: pc });
              if (r.ok) {
                setMsg({ ok: true, text: `Confirmed: ${r.label}` });
                setPc("");
              } else {
                setMsg({ ok: false, text: r.reason ?? "Couldn't confirm" });
              }
            } finally {
              setBusy(false);
            }
          }}
          className="text-xs px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50 shrink-0"
        >
          {busy ? "Checking…" : "Confirm"}
        </button>
      </div>
      {msg && (
        <p
          className="mt-1.5 text-xs"
          style={{ color: msg.ok ? "#22c55e" : "#ef4444" }}
        >
          {msg.text}
        </p>
      )}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <label className="text-xs text-[#cbd5e1] flex items-center gap-1.5">
          Heavy items reach
          <input
            type="number"
            min={1}
            defaultValue={settings.hub_heavy_max_km ?? 5}
            onBlur={(e) =>
              void update({ hub_heavy_max_km: Number(e.target.value) || 5 })
            }
            className="w-14 text-sm rounded-lg px-2 py-1"
            style={INPUT_STYLE}
          />
          km
        </label>
        <label className="text-xs text-[#cbd5e1] flex items-center gap-1.5">
          Max range
          <input
            type="number"
            min={1}
            defaultValue={settings.hub_max_km ?? 30}
            onBlur={(e) =>
              void update({ hub_max_km: Number(e.target.value) || 30 })
            }
            className="w-14 text-sm rounded-lg px-2 py-1"
            style={INPUT_STYLE}
          />
          km
        </label>
      </div>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function SettingsDrawer({ onClose }: Props) {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const [pollingInput, setPollingInput] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveOk, setSaveOk] = useState(false);
  const { editMode, toggleEditMode, layout } = useEditMode();

  const hiddenPanelCount = PANEL_WIDGETS.filter((w) =>
    layout.hiddenPanels.includes(w.id),
  ).length;
  const hiddenStatCount = STAT_WIDGETS.filter((w) =>
    layout.hiddenStats.includes(w.id),
  ).length;
  const totalHidden = hiddenPanelCount + hiddenStatCount;

  function handleEditDashboard() {
    if (!editMode) toggleEditMode();
    onClose();
  }

  async function applyField(fields: Parameters<typeof updateSettings>[0]) {
    setSaveError("");
    setSaveOk(false);
    try {
      await updateSettings(fields);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  const polling = settings?.polling_interval_ms ?? 300000;
  const displayPolling =
    pollingInput !== "" ? pollingInput : String(Math.round(polling / 60000));

  async function handlePollingBlur() {
    const mins = parseInt(pollingInput || String(Math.round(polling / 60000)));
    if (isNaN(mins)) return;
    const ms = Math.max(60000, Math.min(3600000, mins * 60000));
    await applyField({ polling_interval_ms: ms });
    setPollingInput("");
  }

  if (settings == null) {
    return (
      <Drawer onClose={onClose} title="Settings">
        <p className="text-sm text-[#8b8fa3]">Loading...</p>
      </Drawer>
    );
  }

  return (
    <Drawer onClose={onClose} title="Settings">
      <div className="space-y-1">
        {/* Dashboard customization — entry point for widget add/remove/reorder. */}
        <div
          className="mb-4 p-3 rounded-lg"
          style={{
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.25)",
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-1">
            <p className="text-sm font-medium text-[#e4e6eb]">Dashboard layout</p>
            <button
              type="button"
              onClick={handleEditDashboard}
              className="px-3 py-1.5 rounded-md text-xs font-medium"
              style={{
                background: "rgba(59,130,246,0.85)",
                color: "#fff",
              }}
            >
              ✎ Edit dashboard
            </button>
          </div>
          <p className="text-xs" style={{ color: "#8b8fa3" }}>
            Drag to reorder, × to hide, + to add. {totalHidden > 0 ? `${totalHidden} hidden.` : "All visible."}
          </p>
        </div>

        <div
          className="mb-4 px-3 py-2 rounded-lg text-xs"
          style={{
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.2)",
            color: "#f59e0b",
          }}
        >
          Safety rails active — changes below affect live Hygglo writes.
        </div>

        <LockedToggle
          label="Read-only mode"
          value={settings.read_only_mode}
          dangerOff
          warning="WARNING: Disabling read-only mode allows the system to write to Hygglo. This is a safety rail. Are you sure?"
          tooltip="Master safety rail — blocks all Hygglo writes"
          onConfirmedChange={(next) => applyField({ read_only_mode: next })}
        />

        <LockedToggle
          label="Allow Hygglo sends"
          value={settings.ALLOW_HYGGLO_SEND}
          dangerOn
          warning="DANGER: Enabling Hygglo sends allows the AI to send real messages to renters on your behalf. Are you absolutely sure?"
          tooltip="Enables AI message dispatch — EXTRA dangerous"
          onConfirmedChange={(next) => applyField({ ALLOW_HYGGLO_SEND: next })}
        />

        <LockedToggle
          label="Escalate to Sonnet"
          value={settings.escalate_to_sonnet}
          warning=""
          tooltip="Use Sonnet model for complex AI responses"
          onConfirmedChange={(next) => applyField({ escalate_to_sonnet: next })}
        />

        <div className="py-3">
          <label className="text-sm text-[#e4e6eb] block mb-1">Polling interval</label>
          <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
            How often to poll Hygglo (minutes, 1-60)
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={displayPolling}
              onChange={(e) => setPollingInput(e.target.value)}
              onBlur={handlePollingBlur}
              className="w-24 text-sm rounded-lg px-3 py-2"
              style={INPUT_STYLE}
            />
            <span className="text-xs text-[#8b8fa3]">min</span>
          </div>
        </div>

        <HubEditor />

        <div className="py-3">
          <label className="text-sm text-[#e4e6eb] block mb-1">Pickup / collection hours</label>
          <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
            Windows you accept pickups &amp; returns (London time). The AI only confirms times inside these.
          </p>
          <div className="space-y-2">
            {(settings.pickup_hours ?? []).map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="time"
                  value={w.start}
                  onChange={(e) =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).map((x, idx) =>
                        idx === i ? { ...x, start: e.target.value } : x,
                      ),
                    })
                  }
                  className="text-sm rounded-lg px-2 py-1.5"
                  style={INPUT_STYLE}
                />
                <span className="text-xs text-[#8b8fa3]">to</span>
                <input
                  type="time"
                  value={w.end}
                  onChange={(e) =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).map((x, idx) =>
                        idx === i ? { ...x, end: e.target.value } : x,
                      ),
                    })
                  }
                  className="text-sm rounded-lg px-2 py-1.5"
                  style={INPUT_STYLE}
                />
                <button
                  onClick={() =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).filter((_, idx) => idx !== i),
                    })
                  }
                  className="text-[#8b8fa3] hover:text-red-400 px-1.5 text-lg leading-none"
                  aria-label="Remove window"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                applyField({
                  pickup_hours: [...(settings.pickup_hours ?? []), { start: "10:00", end: "12:00" }],
                })
              }
              className="text-xs px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12]"
            >
              + Add window
            </button>
          </div>
        </div>

        <HardTruthsEditor />
      </div>

      {saveError && (
        <p className="mt-3 text-xs" style={{ color: "#ef4444" }}>{saveError}</p>
      )}
      {saveOk && (
        <p className="mt-3 text-xs" style={{ color: "#22c55e" }}>Saved.</p>
      )}
    </Drawer>
  );
}
