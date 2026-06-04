"use client";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { HeaderBar } from "@/components/dashboard/HeaderBar";
import { EditModeBar } from "@/components/dashboard/EditModeBar";
import { AddWidgetDrawer } from "@/components/dashboard/AddWidgetDrawer";
import { EditableWidget } from "@/components/dashboard/EditableWidget";
import { WidgetErrorBoundary } from "@/components/dashboard/WidgetErrorBoundary";
import { PANEL_WIDGETS } from "@/lib/dashboard/widget-registry";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import { DeferredMount } from "@/lib/dashboard/deferred-mount";
import { DashboardHydrationProvider } from "@/lib/dashboard/hydration-context";

// CRITICAL above-the-fold panels — mount eagerly so they paint in the
// first frame. These are the operational surfaces the user needs instantly:
// the KPI stat grid, the calendar strip, and the next-rentals / due-returns
// lists. StatsGrid carries its own internal skeleton while getStatsDrawerData
// resolves, so the page never shows a blank hero.
//
// Everything else (revenue charts, AI assistant, analytics / intel / rankings)
// is SECONDARY: it is deferred behind an IntersectionObserver and shows a
// shimmering PanelSkeleton until it scrolls into view, so its useQuery calls
// don't fire during the critical first paint. The FINAL rendered page is
// visually identical — only the mount *timing* changes.
const EAGER_PANELS = new Set([
  "stats-grid",
  "calendar-strip",
  "next-rentals",
  "return-hub",
]);

// Per-panel skeleton sizing so the reserved space matches the real widget's
// height — keeps cumulative layout shift ~0 when the deferred panel pops in.
// Heights are approximations of each panel's rendered height (glass-card +
// content). Anything not listed falls back to the DeferredMount default.
const PANEL_SKELETON: Record<string, { height: string; rows: number }> = {
  "competitor-intel": { height: "120px", rows: 1 },   // default-collapsed
  "ai-chat":          { height: "440px", rows: 4 },
  lifetime:           { height: "470px", rows: 4 },
  "earnings-chart":   { height: "340px", rows: 3 },
  "tax-summary":      { height: "300px", rows: 3 },
  "live-activity":    { height: "260px", rows: 3 },
  "conversation-funnel": { height: "260px", rows: 3 },
  "item-revenue":     { height: "320px", rows: 4 },
  "top-bundles":      { height: "300px", rows: 4 },
  "item-cycle":       { height: "300px", rows: 4 },
  "out-of-stock":     { height: "240px", rows: 3 },
  "missed-revenue":   { height: "260px", rows: 3 },
  scorecard:          { height: "300px", rows: 3 },
  "sell-recommender": { height: "280px", rows: 3 },
  "price-recos":      { height: "300px", rows: 3 },
  "ai-insights":      { height: "300px", rows: 3 },
  "health-scanner":   { height: "260px", rows: 3 },
  "hygglo-inbox":     { height: "280px", rows: 3 },
  "item-roi":         { height: "300px", rows: 4 },
  "lost-revenue-buy": { height: "300px", rows: 3 },
  "verification-funnel": { height: "300px", rows: 4 },
  "equipment-value":  { height: "300px", rows: 3 },
};

export default function DashboardPage() {
  const { layout, reorderPanels, isPanelHidden } = useEditMode();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const visiblePanels = layout.panelOrder
    .filter((id) => !isPanelHidden(id))
    .map((id) => PANEL_WIDGETS.find((w) => w.id === id))
    .filter((w): w is (typeof PANEL_WIDGETS)[number] => Boolean(w));

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = layout.panelOrder.indexOf(String(active.id));
    const newIndex = layout.panelOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    reorderPanels(arrayMove(layout.panelOrder, oldIndex, newIndex));
  };

  return (
    <DashboardHydrationProvider>
      <div style={{ background: "#070910", minHeight: "100dvh" }}>
        <HeaderBar />
        <EditModeBar />
        <main
          className="mx-auto px-4 md:px-6 py-5"
          style={{ maxWidth: "1440px" }}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visiblePanels.map((w) => w.id)}
              strategy={verticalListSortingStrategy}
            >
              {visiblePanels.map(({ id, label, component: Component }) => {
                const skel = PANEL_SKELETON[id];
                return (
                  <div key={id} className="mb-4">
                    <EditableWidget id={id} kind="panel" label={label}>
                      <WidgetErrorBoundary label={label}>
                        <DeferredMount
                          eager={EAGER_PANELS.has(id)}
                          placeholderHeight={skel?.height}
                          skeletonRows={skel?.rows}
                        >
                          <Component />
                        </DeferredMount>
                      </WidgetErrorBoundary>
                    </EditableWidget>
                  </div>
                );
              })}
            </SortableContext>
          </DndContext>
        </main>
        <AddWidgetDrawer />
      </div>
    </DashboardHydrationProvider>
  );
}
