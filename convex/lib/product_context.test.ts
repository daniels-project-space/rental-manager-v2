import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteProduct, insertProduct, loadProductContext, patchProduct, projectProduct, refreshProductContext } from "./product_context";
import { audit, backfill } from "../product_context_admin";

function fixture(source: Record<string, any>[] = [], compact: Record<string, any>[] = []) {
  const rows: Record<string, Record<string, any>[]> = { hygglo_products: structuredClone(source), hygglo_product_context: structuredClone(compact) };
  const reads: string[] = [], writes: string[] = [];
  let next = 0;
  const ctx = { db: {
    query(table: string) {
      const predicates: Array<(row: Record<string, any>) => boolean> = [];
      const q: any = { withIndex(_name: string, build: (range: any) => any) {
        const range: any = { eq(key: string, value: any) { predicates.push((row) => row[key] === value); return range; } };
        build(range); return q;
      }, async collect() {
        reads.push(table);
        return rows[table].filter((row) => predicates.every((test) => test(row)))
          .sort((a,b) => a._creationTime - b._creationTime);
      }, async first() { return (await q.collect())[0] ?? null; },
      async paginate(options: {cursor: string|null; numItems: number}) {
        const all = await q.collect(), offset = Number(options.cursor ?? 0), end = offset + options.numItems;
        return { page: all.slice(offset,end), continueCursor:String(end), isDone:end>=all.length };
      } };
      return q;
    },
    async get(id: string) { return Object.values(rows).flat().find((row) => row._id === id) ?? null; },
    async insert(table: string, value: Record<string, any>) {
      const id = `${table}-${++next}`;
      rows[table].push({ ...structuredClone(value), _id: id, _creationTime: 1000 + next });
      writes.push(table); return id;
    },
    async patch(id: string, value: Record<string, any>) {
      for (const [table, tableRows] of Object.entries(rows)) {
        const row = tableRows.find((row) => row._id === id);
        if (!row) continue;
        for (const [key, field] of Object.entries(value)) {
          if (field === undefined) delete row[key]; else row[key] = structuredClone(field);
        }
        writes.push(table); return;
      }
      throw new Error("Missing patch source");
    },
    async delete(id: string) {
      for (const [table, tableRows] of Object.entries(rows)) {
        const index = tableRows.findIndex((row) => row._id === id);
        if (index < 0) continue;
        tableRows.splice(index, 1); writes.push(table); return;
      }
    },
  } } as unknown as MutationCtx;
  return { ctx, rows, reads, writes };
}
const product = (id = "source", extra: Record<string, any> = {}): Doc<"hygglo_products"> => ({
  _id: id, _creationTime: 1, accountSlug: "leo", productId: 77, name: "Sony FX3",
  description: "Included: Sony FX3", masterItemId: "camera", isMarketingOnly: true,
  lastSyncedAt: 100, images: [{ thumbnailUrl: "/thumb", fullSizeUrl: "/full" }], ...extra,
}) as Doc<"hygglo_products">;

describe("transactional compact product contexts", () => {
  it("keeps only needed fields, exact flags, and at most the first six image pairs", () => {
    const source = product("p", { isMarketingOnlyOverride: false,
      listings: [{ location: { payload: "x".repeat(100000) } }],
      images: Array.from({length: 8}, (_, i) => ({thumbnailUrl:`/t${i}`,fullSizeUrl:i ? `/f${i}` : "/t0"})),
    });
    const compact = projectProduct(source);
    expect(compact.is_marketing_only_override).toBe(false);
    expect(compact.image_urls).toEqual(["/t0",...Array.from({length:5},(_,i)=>[`/t${i+1}`,`/f${i+1}`]).flat()]);
    expect(compact).not.toHaveProperty("listings");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(source).length / 5);
  });

  it("reads through legacy/missing projections and then reads the v2 mirror without rich source reads", async () => {
    const f = fixture([product()], [{_id:"legacy",_creationTime:1,account_slug:"leo",product_id:77,name:"stale",source_last_synced_at:999}]);
    expect(await loadProductContext(f.ctx,"leo",77)).toEqual(projectProduct(product()));
    expect(await refreshProductContext(f.ctx,"leo",77)).toBe("updated");
    f.reads.length = 0;
    expect(await loadProductContext(f.ctx,"leo",77)).toMatchObject({name:"Sony FX3",projection_version:2});
    expect(f.reads).toEqual(["hygglo_product_context"]);
  });

  it("shares the same pending indexed read across stock qualification and images", async () => {
    const f = fixture([product()], [{...projectProduct(product()),_id:"compact",_creationTime:1}]);
    const cache = new Map();
    const [a,b] = await Promise.all([loadProductContext(f.ctx,"leo",77,cache),loadProductContext(f.ctx,"leo",77,cache)]);
    expect(a).toEqual(b);
    expect(f.reads).toEqual(["hygglo_product_context"]);
    expect(await loadProductContext(f.ctx,"diogo",77,cache)).toBeNull();
  });

  it("selects the oldest source duplicate rather than the newest sync timestamp", async () => {
    const first = product("first", {_creationTime:1,lastSyncedAt:10,isMarketingOnlyOverride:false});
    const later = product("later", {_creationTime:2,lastSyncedAt:999,name:"Different kit",masterItemId:"other"});
    const f = fixture([later,first]);
    await refreshProductContext(f.ctx,"leo",77);
    expect(f.rows.hygglo_product_context[0]).toMatchObject({source_product_id:"first",name:"Sony FX3",source_last_synced_at:10});
    await patchProduct(f.ctx,later._id,{name:"Still not first"},later);
    expect(f.rows.hygglo_product_context[0].name).toBe("Sony FX3");
  });

  it("updates images, manual flags and item identity together with source patches", async () => {
    const source = product(); const f = fixture([source]);
    await patchProduct(f.ctx,source._id,{isMarketingOnlyOverride:false,masterItemId:"new-camera" as any,images:[{fullSizeUrl:"/new"}]},source);
    expect(f.rows.hygglo_product_context[0]).toMatchObject({master_item_id:"new-camera",is_marketing_only_override:false,image_urls:["/new"]});
    await patchProduct(f.ctx,source._id,{isMarketingOnlyOverride:undefined,description:undefined});
    expect(f.rows.hygglo_product_context[0]).not.toHaveProperty("is_marketing_only_override");
    expect(f.rows.hygglo_product_context[0]).not.toHaveProperty("description");
  });

  it("repairs both identities when a source key moves", async () => {
    const source = product(); const f = fixture([source]);
    await refreshProductContext(f.ctx,"leo",77);
    await patchProduct(f.ctx,source._id,{accountSlug:"diogo",productId:88},source);
    expect(f.rows.hygglo_product_context).toHaveLength(1);
    expect(f.rows.hygglo_product_context[0]).toMatchObject({account_slug:"diogo",product_id:88});
  });

  it("reveals the next oldest duplicate on deletion and removes stale mirrors when none remain", async () => {
    const first = product("first"), second = product("second",{_creationTime:2,name:"Second"});
    const f = fixture([first,second]);
    await refreshProductContext(f.ctx,"leo",77);
    await deleteProduct(f.ctx,first._id);
    expect(f.rows.hygglo_product_context[0].name).toBe("Second");
    f.rows.hygglo_product_context.push({...f.rows.hygglo_product_context[0],_id:"stale-copy",_creationTime:5});
    await deleteProduct(f.ctx,second._id);
    expect(f.rows.hygglo_product_context).toEqual([]);
    expect(await loadProductContext(f.ctx,"leo",77)).toBeNull();
  });

  it("creates projections on insertion and does not rewrite unchanged mirrors", async () => {
    const f = fixture(); const {_id,_creationTime,...data} = product();
    const id = await insertProduct(f.ctx,data);
    expect(f.rows.hygglo_product_context[0].source_product_id).toBe(id);
    f.writes.length = 0;
    expect(await refreshProductContext(f.ctx,"leo",77)).toBe("unchanged");
    expect(f.writes).toEqual([]);
  });

  it("backfills checkpointed pages and audits every projected field without source writes", async () => {
    const f = fixture([product("first"),product("second",{productId:88,_creationTime:2})]);
    const first = await (backfill as any)._handler(f.ctx,{paginationOpts:{cursor:null,numItems:1}});
    expect(first).toMatchObject({scanned:1,inserted:1,isDone:false});
    const second = await (backfill as any)._handler(f.ctx,{paginationOpts:{cursor:first.continueCursor,numItems:1}});
    expect(second).toMatchObject({scanned:1,inserted:1,isDone:true});
    expect(f.writes.every((table)=>table==="hygglo_product_context")).toBe(true);
    f.writes.length = 0;
    expect(await (audit as any)._handler(f.ctx,{paginationOpts:{cursor:null,numItems:50}})).toMatchObject({scanned:2,checkedKeys:2,mismatches:[],isDone:true});
    f.rows.hygglo_product_context[0].is_marketing_only = false;
    const result = await (audit as any)._handler(f.ctx,{paginationOpts:{cursor:null,numItems:50}});
    expect(result.mismatches[0].fields).toEqual(["is_marketing_only"]);
    expect(f.writes).toEqual([]);
  });

  it("rejects unbounded migration and audit pages", async () => {
    const f = fixture([product()]);
    for (const registered of [backfill,audit]) {
      await expect((registered as any)._handler(f.ctx,{paginationOpts:{cursor:null,numItems:51}})).rejects.toThrow("1–50");
    }
    expect(f.reads).toEqual([]);
  });
});
