import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { convexToJson } from "convex/values";

type QueryObserver = (name: string, result: unknown) => void;

/** One request and one verified identity; never reuse reads across writes. */
export function createConvexQuerySession(client: ConvexHttpClient, observe?: QueryObserver) {
  const memo = new Map<string, Promise<unknown>>();
  const stats = { queries: 0, dedupedRoundTrips: 0 };
  let writes = 0;
  let revision = 0;
  const query: typeof client.query = (fn, args) => {
    const name = getFunctionName(fn);
    // Order reads prove a transition and must always reach Native.
    const cacheable = writes === 0 && name !== "renter_bot_lab_order:get";
    const key = `${name}|${JSON.stringify(convexToJson(args ?? {}), (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value)}`;
    if (cacheable) {
      const hit = memo.get(key);
      if (hit) {
        stats.dedupedRoundTrips++;
        return hit as ReturnType<typeof client.query>;
      }
    }
    stats.queries++;
    const readRevision = revision;
    const result = client.query(fn, args).then(value => {
      // A pre-write read finishing late must not add stale facts to the
      // post-write evidence assembled by the route.
      if (readRevision === revision && writes === 0) observe?.(name, value);
      return value;
    });
    if (cacheable) {
      memo.set(key, result);
      // A transient failure is not a reusable answer. Do not let an older
      // failed read evict a newer entry after a concurrent write.
      void result.catch(() => { if (memo.get(key) === result) memo.delete(key); });
    }
    return result;
  };
  const write = (method: "mutation" | "action") => async (fn: Parameters<typeof client.mutation>[0], args: Record<string, unknown>) => {
    writes++;
    revision++;
    memo.clear();
    const invoke = client[method].bind(client) as (fn: Parameters<typeof client.query>[0], args: Record<string, unknown>) => Promise<unknown>;
    try { return await invoke(fn as never, args); }
    finally {
      writes--;
      revision++;
      // Even a rejected/failed action may have written before throwing.
      memo.clear();
    }
  };
  const mutation = write("mutation"), action = write("action");
  const scoped = new Proxy(client, {
    get(target, key) {
      if (key === "query") return query;
      if (key === "mutation") return mutation;
      if (key === "action") return action;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client: scoped, stats };
}
