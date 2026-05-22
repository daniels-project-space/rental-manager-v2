"use client";
/**
 * WallESignals — live chip strip + signal hook for the WallE widget.
 *
 * Subscribes to the 5 dashboard streams Phase 3 surfaces:
 *   - getActiveConflicts        → 'conflict'   (alert)
 *   - listPendingWithoutDecision → 'pending'   (info)
 *   - getDueReturns             → 'due_return' (warn / alert if overdue)
 *   - getRevenueDelta           → 'revenue_up' / 'revenue_down'
 *   - getUtilizationDelta       → 'utilization_spike' / 'utilization_drop'
 *
 * The reactive Signal[] is exposed via useWallESignals() so WallE.tsx
 * (Phase 8) can feed it into deriveMood(). The visual chip strip is
 * rendered by <WallESignals /> for direct embedding under the orb.
 */

import { useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Signal, SignalSeverity } from "./walle.types";

const SEVERITY_STYLES: Record<
  SignalSeverity,
  { bg: string; fg: string; border: string }
> = {
  alert: {
    bg: "rgba(220,38,38,0.15)",
    fg: "#fca5a5",
    border: "rgba(220,38,38,0.35)",
  },
  warn: {
    bg: "rgba(245,158,11,0.15)",
    fg: "#fcd34d",
    border: "rgba(245,158,11,0.35)",
  },
  info: {
    bg: "rgba(59,130,246,0.15)",
    fg: "#93c5fd",
    border: "rgba(59,130,246,0.35)",
  },
};

/**
 * Hook variant — returns the derived Signal[] plus a lastChangeAt
 * timestamp so parent components can detect "something new happened"
 * without doing array equality themselves.
 */
export function useWallESignals(
  accountSlug: string | null = null,
): { signals: Signal[]; lastChangeAt: number } {
  const conflicts = useQuery(api.dashboard_insights.getActiveConflicts, {});
  const pending = useQuery(api.reservations.listPendingWithoutDecision, {
    limit: 10,
  });
  const dueReturns = useQuery(api.reservations.getDueReturns, { accountSlug });
  const revenue = useQuery(api.dashboard_insights.getRevenueDelta, {});
  const utilization = useQuery(api.dashboard_insights.getUtilizationDelta, {});

  // Stable timestamp per render-result so chips show "recent first" without
  // a wall-clock churn on every render. Updates whenever any query payload
  // changes identity (Convex returns stable refs across no-op refreshes).
  const tsRef = useRef<number>(Date.now());
  const lastChangeAtRef = useRef<number>(Date.now());
  const inputsKey =
    String(conflicts?.length ?? "x") +
    "|" +
    String(pending?.length ?? "x") +
    "|" +
    String(dueReturns?.length ?? "x") +
    "|" +
    String(revenue?.mtdGbp ?? "x") +
    ":" +
    String(revenue?.vsLastMonthPct ?? "x") +
    "|" +
    String(utilization?.length ?? "x");
  const lastKeyRef = useRef<string>("");
  if (lastKeyRef.current !== inputsKey) {
    lastKeyRef.current = inputsKey;
    tsRef.current = Date.now();
    lastChangeAtRef.current = tsRef.current;
  }

  const signals: Signal[] = useMemo(() => {
    const out: Signal[] = [];
    const ts = tsRef.current;

    // 1. Conflicts — always alert.
    for (const c of conflicts ?? []) {
      out.push({
        id: `conflict:${c.id}`,
        kind: "conflict",
        label: `${c.item} double-booked (${c.dates})`,
        severity: "alert",
        ts,
      });
    }

    // 2. Due returns — warn (overdue → alert).
    for (const d of dueReturns ?? []) {
      out.push({
        id: `due:${d.reservationId}`,
        kind: "due_return",
        label: d.isOverdue
          ? `Overdue: ${d.renterName} (${d.endDate})`
          : `Due today: ${d.renterName}`,
        severity: d.isOverdue ? "alert" : "warn",
        ts,
      });
    }

    // 3. Pending review backlog — single rolled-up chip.
    if ((pending?.length ?? 0) > 0) {
      out.push({
        id: `pending:count`,
        kind: "pending",
        label: `${pending!.length} pending review`,
        severity: "info",
        ts,
      });
    }

    // 4. Revenue delta vs last month.
    if (revenue && typeof revenue.vsLastMonthPct === "number") {
      const pct = revenue.vsLastMonthPct;
      if (pct >= 5) {
        out.push({
          id: `rev:up`,
          kind: "revenue_up",
          label: `Revenue +${pct.toFixed(1)}% MTD`,
          severity: "info",
          ts,
        });
      } else if (pct <= -5) {
        out.push({
          id: `rev:down`,
          kind: "revenue_down",
          label: `Revenue ${pct.toFixed(1)}% MTD`,
          severity: "warn",
          ts,
        });
      }
    }

    // 5. Utilization top mover (just the #1 to avoid noise).
    if (utilization && utilization.length > 0) {
      const top = utilization[0];
      if (top.deltaPct >= 20) {
        out.push({
          id: `util:up:${top.itemId}`,
          kind: "utilization_spike",
          label: `${top.name} +${top.deltaPct.toFixed(0)}% util`,
          severity: "info",
          ts,
        });
      } else if (top.deltaPct <= -20) {
        out.push({
          id: `util:down:${top.itemId}`,
          kind: "utilization_drop",
          label: `${top.name} ${top.deltaPct.toFixed(0)}% util`,
          severity: "warn",
          ts,
        });
      }
    }

    return out;
  }, [conflicts, pending, dueReturns, revenue, utilization]);

  return { signals, lastChangeAt: lastChangeAtRef.current };
}

/**
 * Visual chip strip. Renders up to 6 signals as severity-tinted pills.
 * Each chip is button-shaped + clickable for future deep-linking
 * (calendar focus / reservation drawer / etc.) — TODO Phase 9.
 */
export function WallESignals({
  accountSlug = null,
}: {
  accountSlug?: string | null;
}) {
  const { signals } = useWallESignals(accountSlug);
  const visible = signals.slice(0, 6);

  if (visible.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          minHeight: "1.75rem",
          opacity: 0.4,
          fontSize: "0.75rem",
          color: "var(--text-secondary, #9ca3af)",
        }}
      >
        All quiet.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {visible.map((s) => {
        const sty = SEVERITY_STYLES[s.severity];
        return (
          <button
            key={s.id}
            type="button"
            // TODO Phase 9: deep-link to source (calendar/reservation drawer).
            onClick={() => {
              /* placeholder — see Phase 9 routing */
            }}
            style={{
              background: sty.bg,
              color: sty.fg,
              border: `1px solid ${sty.border}`,
              borderRadius: "9999px",
              padding: "0.25rem 0.75rem",
              fontSize: "0.75rem",
              fontWeight: 500,
              cursor: "pointer",
              transition: "transform 120ms ease, opacity 120ms ease",
              whiteSpace: "nowrap",
              maxWidth: "20rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={s.label}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
