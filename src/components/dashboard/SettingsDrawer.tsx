"use client";
import { useMutation, useQuery } from "convex/react";
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
