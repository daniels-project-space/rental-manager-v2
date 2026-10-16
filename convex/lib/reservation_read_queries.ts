import type { QueryCtx } from "../_generated/server";
import { reservationReadIndexes } from "./reservation_read_indexes";
import { decodeReservationRead, reservationReadGate } from "./reservation_read_model";

const modeKey = Symbol("reservationReadMode");
type ReadContext = QueryCtx & { [modeKey]?: "source" | "cached" | "prepared" };
const originals = new WeakMap<object, QueryCtx["db"]>();
const rangeMethods = new Set(["eq", "gt", "gte", "lt", "lte"]);
type RangeOperation = { method: string; args: unknown[] };

/** Observe the real source builder: clock expressions execute exactly once. */
function recordRange(builder: any, operations: RangeOperation[]): any {
  return new Proxy(builder, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof key === "string" && rangeMethods.has(key)) return (...args: unknown[]) => {
      operations.push({ method: key, args });
      return recordRange(value.apply(target, args), operations);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function replayRange(builder: any, operations: RangeOperation[]) {
  let current = builder;
  for (const operation of operations) {
    const [field, ...values] = operation.args;
    current = current[operation.method](field === "_creationTime" ? "source_creation_time" : field, ...values);
  }
  return current;
}

/** Install only on read handlers. Keep context identity for existing WeakMap
 * memoization and stock/pricing source-vs-prepared qualification flags. */
export function useReservationReadModel(ctx: QueryCtx, strict = false): QueryCtx {
  const context = ctx as ReadContext;
  if (context[modeKey]) return ctx;
  const descriptor = Object.getOwnPropertyDescriptor(ctx, "db");
  if (!Object.isExtensible(ctx) || Object.isFrozen(ctx) || descriptor && ("writable" in descriptor ? !descriptor.writable : !descriptor.set)) return ctx;
  const db = ctx.db;
  let gate: Promise<boolean> | undefined;
  const usable = () => gate ??= (async () => {
    try {
      const state = await reservationReadGate({ db });
      if (state?.ready && state.version === 1 && (state.enabled || strict)) return true;
      if (strict) throw Error("Prepared reservation reads are unavailable");
      return false;
    } catch (error) { if (strict) throw error; return false; }
  })();
  function wrapQuery(source: any, cached: any): any {
    return new Proxy(source, { get(target, key) {
      if (key === "withIndex") return (name: string, build?: (q: any) => any) => {
        if (!Object.prototype.hasOwnProperty.call(reservationReadIndexes, name) && name !== "by_creation_time") return target.withIndex(name, build);
        const operations: RangeOperation[] = [];
        const nextSource = target.withIndex(name, build ? (q: any) => build(recordRange(q, operations)) : undefined);
        const indexName = name === "by_creation_time" ? "by_source_creation_time" : name;
        const nextCache = () => (db.query("reservation_read_records") as any).withIndex(indexName,
          build ? (q: any) => replayRange(q, operations) : undefined);
        return wrapQuery(nextSource, nextCache);
      };
      if (key === "order") return (direction: "asc" | "desc") => wrapQuery(target.order(direction), () => cached().order(direction));
      if (["collect", "first", "take", "unique"].includes(String(key))) return async (...args: any[]) => {
        if (key === "take" && (!Number.isSafeInteger(args[0]) || args[0] < 0 || args[0] > 4000)) return target.take(...args);
        if (!await usable()) return target[key](...args);
        try {
          const query = cached();
          const records = key === "collect" ? await query.collect() : await query.take(key === "take" ? args[0] + 1 : 2);
          // The derived table has its own creation-time tie breaker. Any source
          // ties retain the original indexed query, including take boundaries.
          const times = new Set<number>();
          if (records.some((row: any) => !Number.isFinite(row.source_creation_time) || times.has(row.source_creation_time) || !times.add(row.source_creation_time))) return target[key](...args);
          if (key === "unique" && records.length > 1) return target.unique();
          const rows = await Promise.all(records.map(decodeReservationRead));
          if (key === "take") return rows.slice(0, args[0]);
          if (key === "first" || key === "unique") return rows[0] ?? null;
          return rows;
        } catch (error) { if (strict) throw error; return target[key](...args); }
      };
      // Filters, pagination, search, iterators and unsupported operations retain
      // the exact original query and its source cursor / expression semantics.
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === "query") return (table: string) => {
      const source = (target.query as any)(table);
      return table === "reservations" ? wrapQuery(source, () => target.query("reservation_read_records").withIndex("by_source_creation_time")) : source;
    };
    if (key === "get") return async (...args: any[]) => {
      if (args.length !== 1 || (typeof target.normalizeId !== "function" || !target.normalizeId("reservations", args[0])) || !await usable()) return (target.get as any)(...args);
      try {
        const row = await target.query("reservation_read_records").withIndex("by_source", q => q.eq("source_id", args[0])).unique();
        return row ? await decodeReservationRead(row) : (target.get as any)(...args);
      } catch (error) { if (strict) throw error; return (target.get as any)(...args); }
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  originals.set(wrapped, db);
  context.db = wrapped;
  context[modeKey] = strict ? "prepared" : "cached";
  return ctx;
}
export function sourceReservationReadContext(ctx: QueryCtx): QueryCtx {
  const db = originals.get(ctx.db) ?? ctx.db;
  return { ...ctx, db, [modeKey]: "source" } as ReadContext;
}
export function preparedReservationReadContext(ctx: QueryCtx): QueryCtx {
  return useReservationReadModel({ ...ctx, db: originals.get(ctx.db) ?? ctx.db, [modeKey]: undefined } as ReadContext, true);
}

const presenceGates = new WeakMap<object, Promise<Awaited<ReturnType<typeof reservationReadGate>>>>();
/** Boolean existence needs neither a complete record nor its compressed body. */
export async function hasReservationByOrder(ctx: QueryCtx, orderId: string): Promise<boolean> {
  const rawDb = originals.get(ctx.db) ?? ctx.db, mode = (ctx as ReadContext)[modeKey];
  const source = async () => !!await rawDb.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", orderId)).first();
  if (mode === "source") return source();
  try {
    let pending = presenceGates.get(ctx);
    if (!pending) { pending = reservationReadGate({ db: rawDb }); presenceGates.set(ctx, pending); }
    const gate = await pending;
    if (gate?.ready && gate.version === 1 && (gate.enabled || mode === "prepared")) {
      return !!await rawDb.query("reservation_order_presence").withIndex("by_order", q => q.eq("hygglo_order_id", orderId)).first();
    }
    if (mode === "prepared") throw Error("Prepared reservation presence is unavailable");
  } catch (error) { if (mode === "prepared") throw error; }
  return source();
}
