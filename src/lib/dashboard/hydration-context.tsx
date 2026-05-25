"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

/**
 * Shared dashboard data — the small set of queries multiple widgets read
 * but Convex would otherwise resolve independently per call site. Convex
 * already dedups same-args useQuery() subscriptions at the wire level, so
 * this context is NOT primarily a bandwidth fix; it's a:
 *
 *   1. React render-dedup: one query, one render, propagate via context.
 *   2. Single source of truth: derived selectors (e.g. activeAccountSlug)
 *      come from one place instead of being recomputed per widget.
 *   3. Future SSR / streaming: the provider is the obvious place to hand
 *      pre-warmed query results into.
 *
 * Widgets that need any of these values should call `useDashboardHydration()`
 * instead of useQuery directly. Widgets that need DIFFERENT args (e.g. a
 * different accountSlug) should still useQuery — Convex dedup handles
 * the wire-level cost.
 *
 * SCOPE — only put queries here that:
 *   - Are needed by ≥2 widgets, AND
 *   - Have the same args across all callers (typically: no args, or the
 *     active account slug from the account-context provider).
 *
 * Currently bundled:
 *   - accounts.list           (5 widgets read this, never changes within session)
 *   - settings.get            (HeaderBar + SettingsDrawer + tax math)
 */

type AccountRow = {
  _id: string;
  slug: string;
  display_name?: string;
  is_active?: boolean;
};

type SettingsRow = Record<string, unknown> | null | undefined;

interface DashboardHydration {
  accounts: AccountRow[] | undefined;
  settings: SettingsRow;
  /** True while EITHER query is still loading (any consumer can show skeleton). */
  isLoading: boolean;
}

const HydrationContext = createContext<DashboardHydration | null>(null);

export function DashboardHydrationProvider({ children }: { children: ReactNode }): ReactNode {
  const accounts = useQuery(api.accounts.list) as AccountRow[] | undefined;
  const settings = useQuery(api.settings.get) as SettingsRow;

  const value: DashboardHydration = {
    accounts,
    settings,
    isLoading: accounts === undefined || settings === undefined,
  };

  return (
    <HydrationContext.Provider value={value}>{children}</HydrationContext.Provider>
  );
}

/**
 * Reads from the hydration context. Returns undefined for missing fields
 * when the provider isn't installed (lets widgets fall back to their own
 * useQuery gracefully — no hard requirement on the provider).
 */
export function useDashboardHydration(): DashboardHydration {
  const ctx = useContext(HydrationContext);
  if (ctx) return ctx;
  return { accounts: undefined, settings: undefined, isLoading: true };
}
