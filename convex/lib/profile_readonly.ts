import { convexToJson } from "convex/values";
import type { QueryCtx } from "../_generated/server";

/** Operator-only attribution of returned documents, not a billing meter. */
export function profileReadonlyDatabase(db: QueryCtx["db"]) {
  type Counter = { calls: number; returnedDocuments: number; estimatedJsonBytes: number; ids: Set<string>; shapes: Set<string> };
  const counters = new Map<string, Counter>();
  const record = (key: string, value: unknown) => {
    let counter = counters.get(key);
    if (!counter) { counter = { calls: 0, returnedDocuments: 0, estimatedJsonBytes: 0, ids: new Set(), shapes: new Set() }; counters.set(key, counter); }
    counter.calls++;
    for (const row of Array.isArray(value) ? value : value == null ? [] : [value]) {
      counter.returnedDocuments++;
      counter.estimatedJsonBytes += new TextEncoder().encode(JSON.stringify(convexToJson(row))).length;
      if (typeof row === "object" && row !== null) {
        if ("_id" in row && typeof row._id === "string") counter.ids.add(row._id);
        if (key === "point:get") counter.shapes.add(Object.keys(row).sort().join(","));
      }
    }
  };
  const wrapQuery = (query: object, table: string, index = "fullTableScan"): object => new Proxy(query, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (property === Symbol.asyncIterator) return async function* () {
        for await (const row of Reflect.apply(method, target, []) as AsyncIterable<unknown>) { record(`${table}:${index}:iterate`, row); yield row; }
      };
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const result = Reflect.apply(method, target, args);
        if (["collect", "take", "first", "unique", "paginate"].includes(String(property))) {
          return Promise.resolve(result).then((value) => {
            const documents = property === "paginate" && value !== null && typeof value === "object" && "page" in value ? value.page : value;
            record(`${table}:${index}:${String(property)}`, documents);
            return value;
          });
        }
        return result !== null && typeof result === "object"
          ? wrapQuery(result, table, property === "withIndex" || property === "withSearchIndex" ? String(args[0]) : index)
          : result;
      };
    },
  });
  const profiledDb = new Proxy(db, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (property === "query") return (table: string) => wrapQuery(Reflect.apply(method, target, [table]), table);
      if (property === "get") return async (...args: unknown[]) => {
        const row = await Reflect.apply(method, target, args); record("point:get", row); return row;
      };
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
  return { db: profiledDb, report: () => [...counters.entries()].map(([operation, c]) => ({
    operation, calls: c.calls, returnedDocuments: c.returnedDocuments, uniqueDocuments: c.ids.size,
    estimatedJsonBytes: c.estimatedJsonBytes, pointDocumentShapes: [...c.shapes],
  })).sort((a, b) => b.estimatedJsonBytes - a.estimatedJsonBytes) };
}
