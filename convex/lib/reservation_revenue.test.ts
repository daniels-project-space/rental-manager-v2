import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteRevenueReservation, insertRevenueReservation, patchRevenueReservation, projectReservationRevenue, refreshReservationRevenue } from "./reservation_revenue";
import { loadCompletedMonthlyRows } from "./monthly_revenue_rows";
import { realisedMonthRevenue, rentalMonthProjectionInputs } from "./reservations/monthRevenue";
import { step, reset } from "../reservation_revenue_admin";

function source(id: string, fields: Record<string, any> = {}): Doc<"reservations"> {
  return { _id:`reservations:${id}`, _creationTime:1, status:"completed", account_slug:"leo",
    start_date:"2026-10-01",end_date:"2026-10-02",hygglo_order_id:id,net_to_owner_gbp:100, ...fields } as Doc<"reservations">;
}
function fixture(initial: Record<string, any>[] = []) {
  const tables: Record<string, Record<string, any>[]> = { reservations:structuredClone(initial),
    reservation_revenue_facts:[],reservation_revenue_ready:[],reservation_revenue_state:[],renter_bot_lab_bookings:[] };
  const reads: string[] = [], writes: string[] = [];
  const namespaces = new Map(Object.entries(tables).flatMap(([table,rows])=>rows.map(row=>[row._id,table] as const)));
  let next=0, failFactWrite=false;
  const clone=(value:any)=>structuredClone(value);
  const ctx={db:{
    normalizeId(table:string,id:string){return namespaces.get(id)===table||id.startsWith(table+":")?id:null;},
    async get(id:string){return clone(Object.values(tables).flat().find(row=>row._id===id)??null);},
    query(table:string){
      const predicates:Array<(row:any)=>boolean>=[];let keys=["_creationTime"];
      const q:any={withIndex(name:string,build:any){
        const range:any={eq(k:string,v:any){predicates.push(r=>r[k]===v);return range;},gte(k:string,v:any){predicates.push(r=>r[k]!==undefined&&r[k]>=v);return range;},lte(k:string,v:any){predicates.push(r=>r[k]!==undefined&&r[k]<=v);return range;}};
        build(range);
        keys=name.includes("pickup_date")?["pickup_date","_creationTime"]:name.includes("start_date")?["start_date","_creationTime"]:name.includes("month")?["effective_month","_creationTime"]:["_creationTime"];
        return q;
      },async collect(){
        reads.push(table);
        return clone((tables[table]??[]).filter(row=>predicates.every(fn=>fn(row))).sort((a,b)=>{
          for(const key of [...keys,"_id"]){if(a[key]===b[key])continue;return a[key]===undefined?-1:b[key]===undefined?1:a[key]<b[key]?-1:1;}return 0;
        }));
      },async first(){return (await q.collect())[0]??null;},async unique(){const rows=await q.collect();if(rows.length>1)throw Error("Duplicate unique key");return rows[0]??null;},
      async paginate(options:any){const rows=await q.collect(),start=Number(options.cursor??0),end=start+options.numItems;return{page:rows.slice(start,end),isDone:end>=rows.length,continueCursor:String(end)};}};
      return q;
    },
    async insert(table:string,value:any){if(failFactWrite&&table==="reservation_revenue_facts")throw Error("Fact write failed");const id=`${table}:${++next}`;(tables[table]??=[]).push({...clone(value),_id:id,_creationTime:10000+next});namespaces.set(id,table);writes.push(table);return id;},
    async patch(id:string,value:any){for(const [table,rows]of Object.entries(tables)){const row=rows.find(r=>r._id===id);if(!row)continue;if(failFactWrite&&table==="reservation_revenue_facts")throw Error("Fact write failed");for(const[key,v]of Object.entries(value)){if(v===undefined)delete row[key];else row[key]=clone(v);}writes.push(table);return;}throw Error("Missing source");},
    async delete(id:string){for(const[table,rows]of Object.entries(tables)){const index=rows.findIndex(r=>r._id===id);if(index>=0){rows.splice(index,1);writes.push(table);return;}}},
  }} as unknown as MutationCtx;
  return {ctx,tables,reads,writes,failWrites(){failFactWrite=true;}};
}
const ready=(f:ReturnType<typeof fixture>)=>f.tables.reservation_revenue_ready.push({_id:"reservation_revenue_ready:ready",_creationTime:1,key:"v1",ready:true,updated_at:1});

describe("completed reservation revenue projection",()=>{
  it("preserves canonical fields and excludes non-contributing records",()=>{
    expect(projectReservationRevenue(source("one",{pickup_date:"2026-09-30",image_hints:[{image_url:"private-image"}]}))).toMatchObject({effective_month:"2026-09",source_id:"reservations:one",source_creation_time:1,net_to_owner_gbp:100});
    expect(projectReservationRevenue(source("one"))).not.toHaveProperty("image_hints");
    for(const fields of [{status:"confirmed"},{is_obsolete:true},{start_date:undefined},{end_date:""},{pickup_date:""}])expect(projectReservationRevenue(source("one",fields))).toBeNull();
  });
  it("tracks inserts, zero values, date/account moves, cancellation and deletion",async()=>{
    const f=fixture();const {_id,_creationTime,...row}=source("one");const id=await insertRevenueReservation(f.ctx,row);
    expect(f.tables.reservation_revenue_facts[0]).toMatchObject({source_id:id,source_creation_time:10001});
    await patchRevenueReservation(f.ctx,id,{net_to_owner_gbp:0,pickup_date:"2026-09-30",account_slug:"diogo"});
    expect(f.tables.reservation_revenue_facts[0]).toMatchObject({net_to_owner_gbp:0,effective_month:"2026-09",account_slug:"diogo"});
    await patchRevenueReservation(f.ctx,id,{status:"cancelled"});expect(f.tables.reservation_revenue_facts).toEqual([]);
    await patchRevenueReservation(f.ctx,id,{status:"completed",pickup_date:undefined});expect(f.tables.reservation_revenue_facts[0].effective_month).toBe("2026-10");
    await deleteRevenueReservation(f.ctx,id);expect(f.tables.reservations).toEqual([]);expect(f.tables.reservation_revenue_facts).toEqual([]);
  });
  it("ignores irrelevant metadata and creates no fact for confirmed inserts",async()=>{
    const f=fixture([source("one")]);await refreshReservationRevenue(f.ctx,source("one")._id);
    f.reads.length=0;f.writes.length=0;
    await patchRevenueReservation(f.ctx,source("one")._id,{last_polled_at:55} as any);
    expect(f.reads).toEqual(["stock_input_cache_state","reservation_read_gate"]);expect(f.writes).toEqual(["reservations"]);
    const {_id,_creationTime,...row}=source("new",{status:"confirmed"});await insertRevenueReservation(f.ctx,row);
    expect(f.tables.reservation_revenue_facts).toHaveLength(1);
  });
  it("never projects reservation-shaped Lab IDs or redirected Lab inserts",async()=>{
    const f=fixture();f.tables.renter_bot_lab_bookings.push({...source("lab"),_id:"renter_bot_lab_bookings:lab"});
    await patchRevenueReservation(f.ctx,"renter_bot_lab_bookings:lab" as any,{status:"completed",net_to_owner_gbp:200});
    const isolated={...f.ctx,db:{...f.ctx.db,insert:(table:string,row:any)=>(f.ctx.db.insert as any)(table==="reservations"?"renter_bot_lab_bookings":table,row)}} as MutationCtx;
    const {_id,_creationTime,...row}=source("new");await insertRevenueReservation(isolated,row);
    expect(f.tables.reservation_revenue_facts).toEqual([]);expect(f.tables.reservations).toEqual([]);expect(f.tables.renter_bot_lab_bookings).toHaveLength(2);
  });
  it("serializes concurrent updates to a single source and fact",async()=>{
    const f=fixture([source("one")]);await Promise.all([patchRevenueReservation(f.ctx,source("one")._id,{net_to_owner_gbp:20}),patchRevenueReservation(f.ctx,source("one")._id,{net_to_owner_gbp:0})]);
    expect(f.tables.reservations[0].net_to_owner_gbp).toBe(0);expect(f.tables.reservation_revenue_facts).toHaveLength(1);expect(f.tables.reservation_revenue_facts[0].net_to_owner_gbp).toBe(0);
  });
  it("disables projection reads if a caller catches a derived-write failure",async()=>{
    const f=fixture([source("one")]);await refreshReservationRevenue(f.ctx,source("one")._id);ready(f);f.failWrites();
    await expect(patchRevenueReservation(f.ctx,source("one")._id,{net_to_owner_gbp:77})).rejects.toThrow("Fact write failed");
    expect(f.tables.reservation_revenue_ready[0].ready).toBe(false);
    const rows=await loadCompletedMonthlyRows(f.ctx,"2026-10-01","2026-10-31",null);
    expect(realisedMonthRevenue(rows.startRows,"2026-10",null).netGbp).toBe(77);
  });
});

describe("compact monthly history reads",()=>{
  const sources=[source("a",{_creationTime:1,net_to_owner_gbp:0}),source("b",{_creationTime:2,account_slug:"diogo",net_to_owner_gbp:50}),
    source("old-start",{_creationTime:3,start_date:"2026-06-01",end_date:"2026-10-04",pickup_date:"2026-10-01",net_to_owner_gbp:75}),
    source("next-month",{_creationTime:4,pickup_date:"2026-11-01",net_to_owner_gbp:999}),source("obsolete",{_creationTime:5,is_obsolete:true}),
    source("bad-day",{_creationTime:6,pickup_date:"2026-10-99",net_to_owner_gbp:10}),
    source("duplicate",{_creationTime:7,hygglo_order_id:"b",account_slug:"diogo",net_to_owner_gbp:70})];
  it.each([null,"leo","diogo","empty"])("matches original canonical revenue/projection for %s without raw history reads",async(account)=>{
    const f=fixture(sources);const original=await loadCompletedMonthlyRows(f.ctx,"2026-07-01","2026-10-31",account);
    for(const row of sources)await refreshReservationRevenue(f.ctx,row._id);ready(f);f.reads.length=0;
    const compact=await loadCompletedMonthlyRows(f.ctx,"2026-07-01","2026-10-31",account);
    const rows=(x:typeof compact)=>[...new Map([...x.startRows,...x.pickupRows].map(r=>[r._id,r])).values()];
    for(const month of ["2026-07","2026-08","2026-09","2026-10"]){const a=realisedMonthRevenue(rows(original),month,account),b=realisedMonthRevenue(rows(compact),month,account);expect(b.netGbp).toBe(a.netGbp);expect(b.rentals.map(r=>r._id)).toEqual(a.rentals.map(r=>r._id));}
    expect(rentalMonthProjectionInputs(rows(compact),"2026-10-16",account)).toEqual(rentalMonthProjectionInputs(rows(original),"2026-10-16",account));
    expect(f.reads).not.toContain("reservations");expect(f.reads).toEqual(["reservation_revenue_ready","reservation_revenue_facts"]);
  });
  it("uses exact original index order when source date/creation keys are tied",async()=>{
    const rows=[source("b",{hygglo_order_id:"same"}),source("a",{hygglo_order_id:"same"})];const f=fixture(rows);
    for(const row of rows)await refreshReservationRevenue(f.ctx,row._id);ready(f);f.reads.length=0;
    const value=await loadCompletedMonthlyRows(f.ctx,"2026-10-01","2026-10-31",null);
    expect(f.reads.filter(t=>t==="reservations")).toHaveLength(2);expect(realisedMonthRevenue(value.startRows,"2026-10",null).rentals[0]._id).toBe("reservations:a");
  });
  it.runIf(!!process.env.RM_HEADLINE_SOURCE_SNAPSHOT)("preserves canonical month values and duplicate ordering across private production rows",async()=>{
    const raw=JSON.parse(fs.readFileSync(process.env.RM_HEADLINE_SOURCE_SNAPSHOT!,"utf8")).reservations;
    const f=fixture(raw);
    f.tables.reservation_revenue_facts=raw.map((row:Doc<"reservations">)=>projectReservationRevenue(row)).filter(Boolean).map((row:any,i:number)=>({...row,_id:`reservation_revenue_facts:${i}`,_creationTime:10000+i}));
    ready(f);
    for(const account of [null,"leo","diogo","dbcinema","db_cinema","dbcinema_web"]){
      f.tables.reservation_revenue_ready[0].ready=false;
      const original=await loadCompletedMonthlyRows(f.ctx,"2026-07-01","2026-10-31",account);
      f.tables.reservation_revenue_ready[0].ready=true;
      const compact=await loadCompletedMonthlyRows(f.ctx,"2026-07-01","2026-10-31",account);
      const rows=(value:typeof compact)=>[...new Map([...value.startRows,...value.pickupRows].map(row=>[row._id,row])).values()];
      for(const month of ["2026-07","2026-08","2026-09","2026-10"]){
        const a=realisedMonthRevenue(rows(original),month,account),b=realisedMonthRevenue(rows(compact),month,account);
        expect(b.netGbp,`${account}/${month}`).toBe(a.netGbp);expect(b.rentals.map(row=>row._id)).toEqual(a.rentals.map(row=>row._id));
      }
      expect(rentalMonthProjectionInputs(rows(compact),"2026-10-16",account)).toEqual(rentalMonthProjectionInputs(rows(original),"2026-10-16",account));
    }
  });
});

describe("checkpointed revenue migration",()=>{
  it("activates only after source and orphan audits and never writes original reservations",async()=>{
    const f=fixture([source("a"),source("b",{_creationTime:2}),source("skip",{_creationTime:3,status:"cancelled"})]);
    let result:any;for(let n=0;n<20;n++){result=await(step as any)._handler(f.ctx,{pageSize:1});if(result.phase==="ready")break;expect(f.tables.reservation_revenue_ready.every(r=>!r.ready)).toBe(true);}
    expect(result).toMatchObject({phase:"ready",backfilled:3,audited:3,facts_audited:2,mismatches:0});expect(f.tables.reservation_revenue_ready[0].ready).toBe(true);expect(f.writes).not.toContain("reservations");
    await(reset as any)._handler(f.ctx,{});expect(f.tables.reservation_revenue_ready[0].ready).toBe(false);expect(f.tables.reservation_revenue_state).toEqual([]);
  });
  it("stops on a field mismatch and does not enable or retry a permanent error",async()=>{
    const f=fixture([source("a")]);await(step as any)._handler(f.ctx,{pageSize:1});f.tables.reservation_revenue_facts[0].net_to_owner_gbp=999;
    expect(await(step as any)._handler(f.ctx,{pageSize:1})).toMatchObject({phase:"failed",mismatches:1});f.reads.length=0;
    expect(await(step as any)._handler(f.ctx,{pageSize:1})).toMatchObject({phase:"failed"});expect(f.reads).toEqual(["reservation_revenue_state"]);
  });
  it("detects orphaned facts before enabling",async()=>{
    const f=fixture([source("a")]);await(step as any)._handler(f.ctx,{pageSize:1});await(step as any)._handler(f.ctx,{pageSize:1});
    f.tables.reservation_revenue_facts.push({...f.tables.reservation_revenue_facts[0],_id:"reservation_revenue_facts:orphan",source_id:"reservations:gone",_creationTime:99999});
    const result=await(step as any)._handler(f.ctx,{pageSize:50});expect(result).toMatchObject({phase:"failed",mismatches:1});expect(f.tables.reservation_revenue_ready).toEqual([]);
  });
});
