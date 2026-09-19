"use client";

import { lazy, Suspense, createContext, useCallback, useContext, useState, type ReactNode } from "react";

const CalendarGantt = lazy(() =>
  import("@/components/dashboard/CalendarGantt").catch(() => ({
    default: () => null,
  })),
);

type CalendarOpenOptions = {
  /** Convex reservation document ID, which is the identity used by the Gantt. */
  reservationId?: string | null;
  /** Date to put inside the initially visible seven-day calendar window. */
  focusDate?: string | null;
  accountSlug?: string | null;
};

type CalendarOverlayContextValue = {
  openCalendar: (options?: CalendarOpenOptions) => void;
};

const CalendarOverlayContext = createContext<CalendarOverlayContextValue | null>(null);

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Start a seven-day window two days before the selected booking, matching the
 * calendar's normal today-centred layout. */
function focusedWeekStart(date?: string | null): string | undefined {
  return date ? addDays(date, -2) : undefined;
}

/**
 * One owner for the weekly-calendar overlay. Widgets can open it without
 * depending on where the Calendar Strip happens to live in a customised layout.
 */
export function CalendarOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<CalendarOpenOptions | null>(null);

  const openCalendar = useCallback((options: CalendarOpenOptions = {}) => {
    setSelection(options);
    setOpen(true);
  }, []);

  return (
    <CalendarOverlayContext.Provider value={{ openCalendar }}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <CalendarGantt
            open={open}
            onClose={() => setOpen(false)}
            weekStartIso={focusedWeekStart(selection?.focusDate)}
            accountSlug={selection?.accountSlug ?? undefined}
            focusedReservationId={selection?.reservationId ?? undefined}
          />
        </Suspense>
      )}
    </CalendarOverlayContext.Provider>
  );
}

export function useCalendarOverlay(): CalendarOverlayContextValue {
  const value = useContext(CalendarOverlayContext);
  if (!value) {
    throw new Error("useCalendarOverlay must be used within CalendarOverlayProvider");
  }
  return value;
}
