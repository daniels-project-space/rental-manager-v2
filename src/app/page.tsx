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

// Above-the-fold panels (always-eager mount). Everything else is deferred
// until it enters the viewport — cuts cold-paint Convex bandwidth ~50%.
const EAGER_PANELS = new Set([
  "stats-grid",
  "lifetime",
  "earnings-chart",
  "live-activity",
]);

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
              {visiblePanels.map(({ id, label, component: Component }) => (
                <div key={id} className="mb-4">
                  <EditableWidget id={id} kind="panel" label={label}>
                    <WidgetErrorBoundary label={label}>
                      <DeferredMount eager={EAGER_PANELS.has(id)}>
                        <Component />
                      </DeferredMount>
                    </WidgetErrorBoundary>
                  </EditableWidget>
                </div>
              ))}
            </SortableContext>
          </DndContext>
        </main>
        <AddWidgetDrawer />
      </div>
    </DashboardHydrationProvider>
  );
}
