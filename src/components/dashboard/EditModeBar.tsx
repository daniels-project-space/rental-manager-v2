"use client";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import {
  PANEL_WIDGETS,
  STAT_WIDGETS,
} from "@/lib/dashboard/widget-registry";

export function EditModeBar() {
  const {
    editMode,
    toggleEditMode,
    layout,
    setShowAddDrawer,
    resetLayout,
  } = useEditMode();

  if (!editMode) return null;

  const hiddenPanels = PANEL_WIDGETS.filter((w) =>
    layout.hiddenPanels.includes(w.id),
  ).length;
  const hiddenStats = STAT_WIDGETS.filter((w) =>
    layout.hiddenStats.includes(w.id),
  ).length;
  const totalHidden = hiddenPanels + hiddenStats;

  return (
    <div
      className="sticky top-14 z-30 flex flex-wrap items-center justify-between gap-2 px-4 md:px-6 py-2 border-b"
      style={{
        background: "rgba(59,130,246,0.12)",
        borderColor: "rgba(59,130,246,0.35)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-center gap-2 text-sm text-blue-200">
        <span className="font-semibold">Editing dashboard</span>
        <span className="text-blue-300/70">
          — drag to reorder, × to hide{totalHidden > 0 ? `, ${totalHidden} hidden` : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowAddDrawer(true)}
          className="px-3 py-1 rounded-md bg-blue-500/20 hover:bg-blue-500/35 text-blue-100 text-sm border border-blue-400/40"
        >
          + Add widget{totalHidden > 0 ? ` (${totalHidden})` : ""}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm("Reset dashboard layout to defaults?")) resetLayout();
          }}
          className="px-3 py-1 rounded-md bg-slate-700/50 hover:bg-slate-700 text-slate-200 text-sm border border-white/10"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={toggleEditMode}
          className="px-3 py-1 rounded-md bg-emerald-500/85 hover:bg-emerald-500 text-white text-sm font-medium"
        >
          Done
        </button>
      </div>
    </div>
  );
}
