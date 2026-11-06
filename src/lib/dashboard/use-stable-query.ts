"use client";
import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useRef } from "react";

function stableQueryValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableQueryValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableQueryValue(record[key])}`).join(",")}}`;
}

export function stableQueryArgsKey(args: unknown): string {
  return stableQueryValue(args);
}

function queryIdentity(query: FunctionReference<"query">): string | object {
  const reference = query as FunctionReference<"query"> & {
    _functionPath?: string;
    _path?: string;
    _name?: string;
  };
  return reference._functionPath ?? reference._path ?? reference._name ?? query;
}

/**
 * Drop-in replacement for convex/react `useQuery` that RETAINS the last
 * loaded value while a new subscription is still loading.
 *
 * Why: Convex returns `undefined` whenever a query's args change (e.g. the
 * dashboard account switch flips `accountSlug`). Every widget's
 * `if (data === undefined) return <Skeleton/>` then fired at once, collapsing
 * the page to skeletons — the page height shrank and the scroll position
 * "jumped", then snapped back when data re-arrived. Keeping the previous
 * value holds the layout stable during refreshes for the SAME query and args.
 * Switching accounts clears the retained result until that account resolves.
 *
 * Retained data is scoped to the query identity and canonicalized arguments,
 * so a delayed account subscription can never show another account's values.
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): Query["_returnType"] | undefined {
  const data = useQuery(query, ...args);
  const identity = queryIdentity(query);
  const argsKey = stableQueryArgsKey(args);
  const last = useRef<{
    identity: string | object;
    argsKey: string;
    data: Query["_returnType"];
  } | undefined>(undefined);
  if (data !== undefined) last.current = { identity, argsKey, data };
  if (data !== undefined) return data;
  return last.current?.identity === identity && last.current.argsKey === argsKey
    ? last.current.data
    : undefined;
}
