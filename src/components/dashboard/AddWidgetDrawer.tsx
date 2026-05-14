"use client";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import {
  PANEL_WIDGETS,
  STAT_WIDGETS,
} from "@/lib/dashboard/widget-registry";

export function AddWidgetDrawer() {
  const {
    showAddDrawer,
    setShowAddDrawer,
    layout,
    togglePanel,
    toggleStat,
  } = useEditMode();

  if (!showAddDrawer) return null;

  const hiddenPanels = PANEL_WIDGETS.filter((w) =>
    layout.hiddenPanels.includes(w.id),
  );
  const hiddenStats = STAT_WIDGETS.filter((w) =>
    layout.hiddenStats.includes(w.id),
  );
  const isEmpty = hiddenPanels.length === 0 && hiddenStats.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
      onClick={() => setShowAddDrawer(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border bg-[#0b0e18] shadow-2xl overflow-hidden"
        style={{ borderColor: "rgba(255,255,255,0.1)", maxHeight: "80dvh" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-sm font-semibold text-slate-100">Add widget</h2>
          <button
            type="button"
            onClick={() => setShowAddDrawer(false)}
            className="text-slate-400 hover:text-white text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-5" style={{ maxHeight: "calc(80dvh - 50px)" }}>
          {isEmpty && (
            <p className="text-sm text-slate-400 text-center py-8">
              All widgets are visible. Click × on a widget to hide it.
            </p>
          )}

          {hiddenPanels.length > 0 && (
            <section>
              <h3 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Panels ({hiddenPanels.length})
              </h3>
              <ul className="divide-y divide-white/5 rounded-lg border border-white/5">
                {hiddenPanels.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between px-3 py-2 hover:bg-white/5"
                  >
                    <span className="text-sm text-slate-200">{w.label}</span>
                    <button
                      type="button"
                      onClick={() => togglePanel(w.id)}
                      className="px-2 py-1 rounded-md bg-emerald-500/85 hover:bg-emerald-500 text-white text-xs font-medium"
                    >
                      + Add
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hiddenStats.length > 0 && (
            <section>
              <h3 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Stat cards ({hiddenStats.length})
              </h3>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {hiddenStats.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between px-3 py-2 rounded-md border border-white/5 hover:bg-white/5"
                  >
                    <span className="text-sm text-slate-200">{w.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleStat(w.id)}
                      className="px-2 py-1 rounded-md bg-emerald-500/85 hover:bg-emerald-500 text-white text-xs font-medium"
                    >
                      + Add
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
