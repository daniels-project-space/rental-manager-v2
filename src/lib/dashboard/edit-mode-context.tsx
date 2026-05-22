"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_STAT_ORDER,
} from "@/lib/dashboard/widget-registry";

const USER_ID = "default";
const DEBOUNCE_MS = 500;

type LayoutState = {
  panelOrder: string[];
  hiddenPanels: string[];
  statOrder: string[];
  hiddenStats: string[];
};

type EditModeContextValue = {
  editMode: boolean;
  toggleEditMode: () => void;
  layout: LayoutState;
  isPanelHidden: (id: string) => boolean;
  isStatHidden: (id: string) => boolean;
  togglePanel: (id: string) => void;
  toggleStat: (id: string) => void;
  reorderPanels: (newOrder: string[]) => void;
  reorderStats: (newOrder: string[]) => void;
  showAddDrawer: boolean;
  setShowAddDrawer: (open: boolean) => void;
  resetLayout: () => void;
};

const EditModeContext = createContext<EditModeContextValue | null>(null);

function mergeOrder(saved: string[] | undefined, defaults: readonly string[]): string[] {
  // Insert new (unsaved) ids at their declared default position, while preserving
  // the user's relative order between ids they have already saved. Without this,
  // a newly-added DEFAULT_*_ORDER entry (e.g. WallE at index 0) gets appended to
  // the end of a pre-existing saved layout instead of landing at its default slot.
  if (!saved || saved.length === 0) return [...defaults];
  const knownDefaults = new Set(defaults);
  const savedKnown = saved.filter((id) => knownDefaults.has(id));
  const savedSet = new Set(savedKnown);
  const result: string[] = [];
  let savedIdx = 0;
  for (const defId of defaults) {
    if (!savedSet.has(defId)) {
      // new widget — insert at default position
      result.push(defId);
    } else {
      // emit saved ids up to and including this one (preserves user reorders between known ids)
      while (savedIdx < savedKnown.length && savedKnown[savedIdx] !== defId) {
        result.push(savedKnown[savedIdx++]);
      }
      if (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
    }
  }
  while (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
  return result;
}

export function EditModeProvider({ children }: { children: React.ReactNode }) {
  const remote = useQuery(api.dashboardLayout.getLayout, { userId: USER_ID });
  const updateLayoutMut = useMutation(api.dashboardLayout.updateLayout);
  const resetLayoutMut = useMutation(api.dashboardLayout.resetLayout);

  const [editMode, setEditMode] = useState(false);
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [local, setLocal] = useState<LayoutState | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate local state from remote whenever a fresh remote arrives AND we have no
  // pending local changes (debounce-flushed). On first load `remote` is undefined
  // (Convex still loading), then `null` (no row), then a row.
  useEffect(() => {
    if (remote === undefined) return;
    setLocal((prev) => {
      if (prev && debounceRef.current) return prev; // don't clobber unflushed edits
      return {
        panelOrder: mergeOrder(remote?.panelOrder, DEFAULT_PANEL_ORDER),
        hiddenPanels: remote?.hiddenPanels ?? [],
        statOrder: mergeOrder(remote?.statOrder, DEFAULT_STAT_ORDER),
        hiddenStats: remote?.hiddenStats ?? [],
      };
    });
  }, [remote]);

  const layout: LayoutState = useMemo(
    () =>
      local ?? {
        panelOrder: [...DEFAULT_PANEL_ORDER],
        hiddenPanels: [],
        statOrder: [...DEFAULT_STAT_ORDER],
        hiddenStats: [],
      },
    [local],
  );

  const persist = useCallback(
    (next: LayoutState) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void updateLayoutMut({ userId: USER_ID, ...next });
      }, DEBOUNCE_MS);
    },
    [updateLayoutMut],
  );

  const apply = useCallback(
    (mut: (prev: LayoutState) => LayoutState) => {
      setLocal((prev) => {
        const base =
          prev ?? {
            panelOrder: [...DEFAULT_PANEL_ORDER],
            hiddenPanels: [],
            statOrder: [...DEFAULT_STAT_ORDER],
            hiddenStats: [],
          };
        const next = mut(base);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const togglePanel = useCallback(
    (id: string) =>
      apply((prev) => ({
        ...prev,
        hiddenPanels: prev.hiddenPanels.includes(id)
          ? prev.hiddenPanels.filter((x) => x !== id)
          : [...prev.hiddenPanels, id],
      })),
    [apply],
  );

  const toggleStat = useCallback(
    (id: string) =>
      apply((prev) => ({
        ...prev,
        hiddenStats: prev.hiddenStats.includes(id)
          ? prev.hiddenStats.filter((x) => x !== id)
          : [...prev.hiddenStats, id],
      })),
    [apply],
  );

  const reorderPanels = useCallback(
    (newOrder: string[]) => apply((prev) => ({ ...prev, panelOrder: newOrder })),
    [apply],
  );

  const reorderStats = useCallback(
    (newOrder: string[]) => apply((prev) => ({ ...prev, statOrder: newOrder })),
    [apply],
  );

  const reset = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLocal({
      panelOrder: [...DEFAULT_PANEL_ORDER],
      hiddenPanels: [],
      statOrder: [...DEFAULT_STAT_ORDER],
      hiddenStats: [],
    });
    void resetLayoutMut({ userId: USER_ID });
  }, [resetLayoutMut]);

  const isPanelHidden = useCallback(
    (id: string) => layout.hiddenPanels.includes(id),
    [layout.hiddenPanels],
  );
  const isStatHidden = useCallback(
    (id: string) => layout.hiddenStats.includes(id),
    [layout.hiddenStats],
  );

  // Body class for CSS hooks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("edit-mode", editMode);
    return () => document.body.classList.remove("edit-mode");
  }, [editMode]);

  const value: EditModeContextValue = {
    editMode,
    toggleEditMode: () => setEditMode((v) => !v),
    layout,
    isPanelHidden,
    isStatHidden,
    togglePanel,
    toggleStat,
    reorderPanels,
    reorderStats,
    showAddDrawer,
    setShowAddDrawer,
    resetLayout: reset,
  };

  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

export function useEditMode(): EditModeContextValue {
  const ctx = useContext(EditModeContext);
  if (!ctx) throw new Error("useEditMode must be used inside <EditModeProvider>");
  return ctx;
}
