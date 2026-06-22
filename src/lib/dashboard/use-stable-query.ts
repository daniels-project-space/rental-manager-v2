"use client";
import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useRef } from "react";

/**
 * Drop-in replacement for convex/react `useQuery` that RETAINS the last
 * loaded value while a new subscription is still loading.
 *
 * Why: Convex returns `undefined` whenever a query's args change (e.g. the
 * dashboard account switch flips `accountSlug`). Every widget's
 * `if (data === undefined) return <Skeleton/>` then fired at once, collapsing
 * the page to skeletons — the page height shrank and the scroll position
 * "jumped", then snapped back when data re-arrived. Keeping the previous
 * value holds the layout stable across the switch; a widget only shows its
 * skeleton on the very first load (when there is no prior value yet).
 *
 * Trade-off: during the ~100-300ms refetch the widget shows the PREVIOUS
 * account's data. That brief staleness is far less jarring than a full-page
 * layout jump, and resolves the moment the new data lands.
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): Query["_returnType"] | undefined {
  const data = useQuery(query, ...args);
  const last = useRef<Query["_returnType"] | undefined>(undefined);
  if (data !== undefined) last.current = data;
  return data === undefined ? last.current : data;
}
