# Dashboard Customization — V1 Parity Plan (V2)

**Goal:** Settings icon → enter edit mode → per-widget show/hide + drag-reorder for all panels and all stat cards. Persist per-user in Convex. Match V1's UX (`/home/ubuntu/rental-manager/src/public/dashboard.html` + `dashboard-core.js`).

**Stack constraints:** Next.js App Router + React + Convex + Tailwind. No existing dnd lib.

---

## 1. Widget registry (single source of truth)

New file: `src/lib/dashboard/widget-registry.ts`

```ts
export type PanelWidget = { id: string; label: string; component: React.ComponentType };
export type StatWidget   = { id: string; label: string };

export const PANEL_WIDGETS: PanelWidget[] = [
  { id: 'lifetime',          label: 'Lifetime Revenue',     component: LifetimeRevenue },
  { id: 'earnings-activity', label: 'Earnings + Activity',  component: EarningsActivityRow }, // composite
  { id: 'calendar-strip',    label: 'Calendar Strip',       component: CalendarStrip },
  { id: 'return-hub',        label: 'Return Hub',           component: ReturnHub },
  { id: 'weekly-calendar',   label: 'Weekly Calendar',      component: WeeklyCalendar },
  { id: 'funnel-revenue',    label: 'Funnel + Revenue + Bundles', component: FunnelRevenueRow }, // composite
  { id: 'item-cycle',        label: 'Item Cycle Tracker',   component: ItemCycleTracker },
  { id: 'out-of-stock',      label: 'Out of Stock',         component: OutOfStockPanel },
  { id: 'missed-revenue',    label: 'Missed Revenue',       component: MissedRevenue },
  { id: 'scorecard',         label: 'Investment Scorecard', component: InvestmentScorecard },
  { id: 'sell-recommender',  label: 'Sell Recommender',     component: SellRecommender },
  { id: 'price-recos',       label: 'Price Recommendations',component: PriceRecommendations },
  { id: 'ai-insights',       label: 'AI Investment Insights', component: AIInvestmentInsights },
  { id: 'health-scanner',    label: 'Health Scanner',       component: HealthScanner },
  { id: 'hygglo-aichat',     label: 'Hygglo Inbox + AI Chat', component: HyggloAIChatRow }, // composite
];

export const STAT_WIDGETS: StatWidget[] = [
  { id: 'active',         label: 'Active' },
  { id: 'earnings',       label: 'Earnings' },
  { id: 'monthly',        label: 'Monthly' },
  { id: 'confirmed',      label: 'Confirmed' },
  { id: 'scanner',        label: 'Scanner' },
  { id: 'ongoing',        label: 'Ongoing' },
  { id: 'upcoming',       label: 'Upcoming' },
  { id: 'ai_boost',       label: 'AI Boost' },
  { id: 'out_of_stock',   label: 'Out of Stock' },
  { id: 'denied_revenue', label: 'Denied Revenue' },
  { id: 'missed_revenue', label: 'Missed Revenue' },
  { id: 'vacation',       label: 'Vacation' },
  { id: 'sell_reco',      label: 'Sell Reco' },
  { id: 'inventory_worth',label: 'Inventory Worth' },
  { id: 'tax',            label: 'Tax' },
  { id: 'business_intel', label: 'Business Intel' },
];
```

**Decision: ATOMIC.** Every widget is its own registry entry, its own row, full-width by default. Existing side-by-side pairings (Earnings+Activity, Funnel+ItemRevenue+Bundles, Hygglo+AIChat) are dissolved — each becomes its own toggleable widget in vertical stack order.

Final panel list (atomic, ~19 entries):
`stats-grid`, `lifetime`, `earnings-chart`, `live-activity`, `calendar-strip`, `return-hub`, `weekly-calendar`, `conversation-funnel`, `item-revenue`, `top-bundles`, `item-cycle`, `out-of-stock`, `missed-revenue`, `scorecard`, `sell-recommender`, `price-recos`, `ai-insights`, `health-scanner`, `hygglo-inbox`, `ai-chat`.

`stats-grid` IS toggleable as a whole panel (decision B), in addition to the 16 individual stat cards inside it being independently toggleable.

---

## 2. Convex schema + mutations

`convex/schema.ts` — add table:

```ts
dashboardLayouts: defineTable({
  userId: v.string(),           // or accountSlug — single-user today, future-proofed
  panelOrder:   v.array(v.string()),
  hiddenPanels: v.array(v.string()),
  statOrder:    v.array(v.string()),
  hiddenStats:  v.array(v.string()),
  updatedAt: v.number(),
}).index('by_user', ['userId']),
```

`convex/dashboardLayout.ts`:
- `getLayout({ userId })` — returns row or `null` (client falls back to registry defaults)
- `updateLayout({ userId, panelOrder?, hiddenPanels?, statOrder?, hiddenStats? })` — partial upsert

Single-user app today → `userId = 'default'` constant. When auth lands, swap for real user id.

---

## 3. Edit-mode + layout context

New file: `src/lib/dashboard/edit-mode-context.tsx`

Provides:
- `editMode: boolean`, `toggleEditMode()`
- `layout`: merged (Convex query + optimistic local state)
- `togglePanel(id)`, `toggleStat(id)` — flip hidden
- `reorderPanels(ids)`, `reorderStats(ids)` — full new order
- `resetLayout()` — clears row, falls back to defaults

Writes: optimistic local update → debounced (500 ms) Convex mutation. Drag firing 30 events/sec must NOT spam Convex.

---

## 4. UI changes

### HeaderBar.tsx
- Add ✎ "Edit dashboard" button next to ⚙. Click → `toggleEditMode()`.
- (Keep ⚙ for the existing SettingsDrawer — orthogonal concern.)

### EditOverlay component (new)
Visible when `editMode === true`:
- Sticky top bar: "Editing dashboard" + "+ Add widget" + "Reset" + "Done" buttons
- Body gets class `edit-mode` for CSS hooks

### Per-widget overlay (new `<EditableWidget>` wrapper)
Wraps every widget render. In edit mode shows:
- Top-left: drag handle (`⋮⋮` icon, `cursor: grab`)
- Top-right: × delete button → `togglePanel(id)` / `toggleStat(id)`
- Subtle dashed border

### Add-widget drawer (new)
Sheet/modal listing all currently hidden widgets (panels + stats sections). Each row: label + "+ Add" button → removes from `hiddenPanels`/`hiddenStats`.

---

## 5. Drag-and-drop

Add dep: `@dnd-kit/core` + `@dnd-kit/sortable` (~25 KB, accessible, React 18+, actively maintained).

Two independent `<SortableContext>`:
- Panels (vertical list strategy)
- Stat cards inside `StatsGrid` (rect sorting strategy for grid)

Drag handles only active when `editMode`.

---

## 6. Render pipeline rewrite

### `src/app/page.tsx`
Replace hardcoded `<section>` stack with:

```tsx
const { layout, editMode } = useDashboardLayout();
const visiblePanels = layout.panelOrder
  .filter(id => !layout.hiddenPanels.includes(id))
  .map(id => PANEL_WIDGETS.find(w => w.id === id))
  .filter(Boolean);

<DndContext onDragEnd={handlePanelDragEnd}>
  <SortableContext items={visiblePanels.map(p => p!.id)}>
    {visiblePanels.map(p => (
      <EditableWidget key={p!.id} id={p!.id} kind="panel" label={p!.label}>
        <p!.component />
      </EditableWidget>
    ))}
  </SortableContext>
</DndContext>
```

### `StatsGrid.tsx`
Same pattern, but the inner `grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6` becomes a SortableContext over `visibleStats`.

### Composite row components (new, small wrappers)
- `EarningsActivityRow.tsx` — keeps current 2-col grid of EarningsChart + LiveActivity
- `FunnelRevenueRow.tsx` — 3-col grid of Funnel + ItemRevenue + TopBundles
- `HyggloAIChatRow.tsx` — 2-col grid

---

## 7. Default behavior + new widgets

`getLayout` returns `null` until user makes first change. Client merges:
- `panelOrder` defaults = `PANEL_WIDGETS.map(w => w.id)` (registry order)
- `hiddenPanels` defaults = `[]` (all visible)
- Same for stats

When a new widget is added to the registry later, it auto-appears at end of order, visible. Removed widgets are filtered out by the `find()` in render.

---

## 8. CSS hooks

Minimal Tailwind additions in `globals.css`:
```css
body.edit-mode .editable-widget { @apply ring-1 ring-dashed ring-blue-400 relative; }
body.edit-mode .editable-widget .drag-handle { @apply absolute top-2 left-2 cursor-grab; }
body.edit-mode .editable-widget .delete-btn  { @apply absolute top-2 right-2; }
```

---

## 9. Files created / modified

**New (5 files):**
- `src/lib/dashboard/widget-registry.ts`
- `src/lib/dashboard/edit-mode-context.tsx`
- `src/components/dashboard/EditableWidget.tsx`
- `src/components/dashboard/EditModeBar.tsx`
- `src/components/dashboard/AddWidgetDrawer.tsx`
- `convex/dashboardLayout.ts`

(No composite row wrappers needed — atomic decision.)

**Modified (5 files):**
- `convex/schema.ts` — add `dashboardLayouts` table
- `src/app/layout.tsx` — wrap with `<EditModeProvider>`
- `src/app/page.tsx` — registry-driven render with DndContext
- `src/components/dashboard/HeaderBar.tsx` — add ✎ button
- `src/components/dashboard/StatsGrid.tsx` — registry-driven render with DndContext

**Deps:** `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`

---

## 10. Build sequence (PR-able stages)

1. **Registry + atomic page.tsx render** — replace hardcoded JSX with registry-driven `.map()`. All widgets render full-width vertically. No edit mode yet. Pure refactor with visual changes (loss of side-by-side pairing) — verify in browser before moving on.
2. **Convex schema + getLayout/updateLayout** — backend only, ship + verify.
3. **EditModeContext + ✎ button + EditModeBar** — toggle visible, no actions wired.
4. **EditableWidget wrapper + delete buttons** — show/hide working end-to-end (no drag yet).
5. **AddWidgetDrawer** — re-add hidden widgets.
6. **@dnd-kit integration** — drag-reorder panels.
7. **Drag-reorder stat cards inside StatsGrid.**
8. **Polish:** Reset button, keyboard a11y, mobile fallback (toggle list, no drag).

---

## 11. Locked decisions

- **A. Atomic** — every widget independently toggleable; no composite groupings.
- **B. Both** — `stats-grid` panel togglable as a whole, AND each of the 16 stat cards inside it independently togglable.
- **D. Skip stat card sizing** for v1 (V1's `statSizes` 1×/2× tiles).
- **C. userId** — `'default'` constant (single-user app today; swap when auth lands).
- **E. Mobile** — drag falls back to toggle-list (decision deferred to Stage 8 polish).
