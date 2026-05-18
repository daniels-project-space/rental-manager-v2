"use client";
import { useQuery } from "convex/react";
import type { FunctionReference, OptionalRestArgs } from "convex/server";
import { useAccount } from "@/lib/account-context";

/**
 * Smart query helpers for dashboard widgets.
 *
 * Why: every widget repeats roughly the same pattern —
 *   const { activeAccountSlug } = useAccount();
 *   const data = useQuery(api.x.y, { accountSlug: activeAccountSlug });
 *   if (data === undefined) return <Skeleton />;
 *   // ... use data
 *
 * These helpers fold that into one line per widget and standardise the
 * loading-state representation. No wire-level cost change (Convex still
 * dedups same-args subscriptions), but they:
 *   - keep widget code short and uniform,
 *   - make it harder to forget account-scoping,
 *   - guarantee `loading: true` only when data is truly absent (not
 *     "data is the literal value `null`" — a real return value Convex
 *     queries are allowed to send).
 */

/**
 * Run a Convex query scoped to the current active account. Pass extra
 * args (other than `accountSlug`) in `extraArgs`.
 *
 * Returns a discriminated union: { loading: true } | { loading: false, data }.
 */
export function useAccountScopedQuery<
  Q extends FunctionReference<"query", "public", { accountSlug: string | null } & Record<string, unknown>>,
>(
  query: Q,
  extraArgs: Omit<Q["_args"], "accountSlug"> = {} as Omit<Q["_args"], "accountSlug">,
):
  | { loading: true; data: undefined }
  | { loading: false; data: Q["_returnType"] } {
  const { activeAccountSlug } = useAccount();
  const args = { accountSlug: activeAccountSlug ?? null, ...extraArgs } as Q["_args"];
  const data = useQuery(query, ...([args] as OptionalRestArgs<Q>));
  if (data === undefined) return { loading: true, data: undefined };
  return { loading: false, data };
}

/**
 * Run a Convex query with no account scoping (cross-account data like
 * inventory lists, listing photos, etc).
 */
export function useGlobalQuery<
  Q extends FunctionReference<"query", "public", Record<string, unknown>>,
>(
  query: Q,
  args: Q["_args"] = {} as Q["_args"],
):
  | { loading: true; data: undefined }
  | { loading: false; data: Q["_returnType"] } {
  const data = useQuery(query, ...([args] as OptionalRestArgs<Q>));
  if (data === undefined) return { loading: true, data: undefined };
  return { loading: false, data };
}
