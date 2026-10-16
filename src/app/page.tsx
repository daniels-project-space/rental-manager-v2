"use client";
import { AutoPackingGrid } from "@/components/dashboard/StatPackingGrid";
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
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { Suspense, useEffect, useState } from "react";
import { HeaderBar } from "@/components/dashboard/HeaderBar";
import { NotificationDeepLink } from "@/components/dashboard/NotificationDeepLink";
import { EditModeBar } from "@/components/dashboard/EditModeBar";
import { AddWidgetDrawer } from "@/components/dashboard/AddWidgetDrawer";
import { EditableWidget } from "@/components/dashboard/EditableWidget";
import { WidgetErrorBoundary } from "@/components/dashboard/WidgetErrorBoundary";
import { PANEL_WIDGETS, panelLayoutClass } from "@/lib/dashboard/widget-registry";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import { DeferredMount } from "@/lib/dashboard/deferred-mount";
import { DashboardHydrationProvider } from "@/lib/dashboard/hydration-context";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
import { CalendarOverlayProvider } from "@/lib/dashboard/calendar-overlay-context";

// CRITICAL panels — mount eagerly so they paint in the first frame. The live
// rental KPIs are editable cards in Stats Grid; these panels contain the
// operational stats, calendar strip, and next-rentals / due-returns lists.
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
  "item-availability": { height: "320px", rows: 4 },
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
  const [notificationOpen, setNotificationOpen] = useState(false);
  useEffect(() => {
    const syncUrl = () => setNotificationOpen(new URL(window.location.href).searchParams.has("thread"));
    const open = () => setNotificationOpen(true);
    window.addEventListener("rm-open-thread", open);
    window.addEventListener("rm-thread-closed", syncUrl);
    window.addEventListener("popstate", syncUrl);
    syncUrl();
    return () => {
      window.removeEventListener("rm-open-thread", open);
      window.removeEventListener("rm-thread-closed", syncUrl);
      window.removeEventListener("popstate", syncUrl);
    };
  }, []);
  // Core dashboard panels must survive layouts saved by older releases.
  // Restore Stats Grid when a saved layout predates the panel, and keep its
  // existing placement when it is already in the saved layout.
  const compatiblePanelOrder = layout.panelOrder.includes("stats-grid")
    ? layout.panelOrder
    : ["stats-grid", ...layout.panelOrder];
  // Pin this owner tool into older saved layouts too, so it never gets lost in
  // the add-widget drawer after a deployment introduces the new control.
  const panelOrder = compatiblePanelOrder.includes("marketing-only-listings")
    ? compatiblePanelOrder
    : [...compatiblePanelOrder, "marketing-only-listings"];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const visiblePanels = panelOrder
    // Keep the rental totals on the page even when an older/saved layout has
    // `stats-grid` marked hidden. The individual stat cards remain editable;
    // hiding the parent panel removed Active Rentals and Expected Monthly
    // entirely for layouts that predate this dashboard change.
    .filter((id) => id === "stats-grid" || !isPanelHidden(id) || (id === "reply-inbox" && notificationOpen))
    .map((id) => PANEL_WIDGETS.find((w) => w.id === id))
    .filter((w): w is (typeof PANEL_WIDGETS)[number] => Boolean(w));

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = panelOrder.indexOf(String(active.id));
    const newIndex = panelOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    reorderPanels(arrayMove(panelOrder, oldIndex, newIndex));
  };

  return (
    <DashboardHydrationProvider>
      <CalendarOverlayProvider>
        <div style={{ background: "#070910", minHeight: "100dvh" }}>
        <HeaderBar />
        <Suspense fallback={null}>
          <NotificationDeepLink />
        </Suspense>
        <EditModeBar />
        <main
          className="mx-auto px-4 md:px-6 py-5"
          style={{ maxWidth: "1440px" }}
        >
          {!visiblePanels.some(panel => panel.id === "calendar-strip") && (
            <section aria-label="Rental tiles" className="mb-4 min-w-0 md:hidden">
              <WidgetErrorBoundary label="Rentals">
                <DeferredMount placeholderHeight="360px"><CalendarStrip /></DeferredMount>
              </WidgetErrorBoundary>
            </section>
          )}
          <div id="dashboard-view">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visiblePanels.map((w) => w.id)}
              strategy={rectSortingStrategy}
            >
              <AutoPackingGrid className="dashboard-panels grid-cols-1 lg:grid-cols-2 gap-3">
              {visiblePanels.map(({ id, label, component: Component }) => {
                const skel = PANEL_SKELETON[id];
                return (
                  <div key={id} className={panelLayoutClass(id)}>
                    <div data-packing-content className="flow-root">
                    <EditableWidget id={id} kind="panel" label={label}>
                      <WidgetErrorBoundary label={label}>
                        <DeferredMount
                          eager={EAGER_PANELS.has(id) || (id === "reply-inbox" && notificationOpen)}
                          placeholderHeight={skel?.height}
                          skeletonRows={skel?.rows}
                        >
                          <Component />
                        </DeferredMount>
                      </WidgetErrorBoundary>
                    </EditableWidget>
                    </div>
                  </div>
                );
              })}
              </AutoPackingGrid>
            </SortableContext>
          </DndContext>
          </div>
        </main>
        <AddWidgetDrawer />
        </div>
      </CalendarOverlayProvider>
    </DashboardHydrationProvider>
  );
}
