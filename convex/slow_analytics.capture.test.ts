import { capture, loadSlowAnalyticsSnapshot } from "./mv/slow_inputs";
import { reservationReadMetadata } from "./lib/reservation_read_model";
import { packCacheValue, cacheByteDigest } from "./lib/lossless_cache_codec";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { jsonToConvex, convexToJson } from "convex/values";
import { getFunctionName } from "convex/server";
import { slowAnalyticsFixture } from "./lib/slow_analytics_fixture.test";
import { computeTopBundleRankings } from "./bundles";
import { computeRentalVolumeByCategory } from "./dashboard";
import { rentalVolumeWindowFromInputs } from "./lib/rental_volume";
import { computeInvestmentInsights } from "./ai_insights";
import { computeInvestmentScorecard } from "./revenue";
import { computeSellRecommendations, computePriceRecommendations } from "./items";
import { startDateWindow, accountStatusRows, compareSourceStrings } from "./lib/analytics_source_order";
import { refreshSlowWidgets } from "./mv/widgets";
import { refreshAll as refreshVolume } from "./mv/rental_volume_by_category";
import { refreshAll as refreshInsights } from "./mv/ai_insights";
import { refreshAll as refreshScorecard } from "./mv/investment_scorecard";
import { refreshAll as refreshKindBreakdown } from "./mv/rental_volume_kind_breakdown";

const expectedPath = process.env.RM_SLOW_ANALYTICS_EXPECTED;
const expected = JSON.parse(fs.readFileSync(expectedPath ?? new URL("../tests/fixtures/slow-analytics-before.json",import.meta.url),"utf8"));
if (Boolean(expectedPath) !== Boolean(process.env.RM_SLOW_ANALYTICS_FIXTURE)) throw Error("Both real source and independent original results are required");
const source: any = process.env.RM_SLOW_ANALYTICS_FIXTURE
  ? jsonToConvex(JSON.parse(fs.readFileSync(process.env.RM_SLOW_ANALYTICS_FIXTURE,"utf8")))
  : slowAnalyticsFixture(expected.clock);
expect(source.capturedAt).toBe(expected.clock);
function freeze(value:any):any { if(value && typeof value==="object" && !Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(freeze);}return value; }
freeze(source);
const tables=source.tables;
const inputs={reservations:tables.reservations,items:tables.items,pricing:tables.pricing_catalog};
const volumeInputs={...inputs,overrides:tables.listing_resolution_override};
const widgetInputs={...inputs,bundleDefinitions:{ok:true as const,value:{bundles:tables.bundles,bundleItems:tables.bundle_items}}};
const bundleInputs={reservations:tables.reservations,bundles:tables.bundles,bundleItems:tables.bundle_items};
const priceFor=async(name:string)=>tables.pricing_catalog.find((p:any)=>p.item_name_canonical===name)??null;
beforeAll(()=>{vi.useFakeTimers();vi.setSystemTime(expected.clock);});
afterAll(()=>vi.useRealTimers());

async function calculate(kind:string,args:any) {
  if(kind==="bundles")return computeTopBundleRankings(bundleInputs,args.accountSlug,args.days,expected.clock);
  if(kind==="volume")return computeRentalVolumeByCategory(rentalVolumeWindowFromInputs(volumeInputs,args.accountSlug,args.days,expected.clock),args.days);
  if(kind==="insights")return computeInvestmentInsights(inputs,args.accountSlug,expected.clock);
  if(kind==="score")return computeInvestmentScorecard(inputs,args.accountSlug,expected.clock);
  if(kind==="sell")return computeSellRecommendations(inputs,args.accountSlug,priceFor,expected.clock);
  if(kind==="price")return computePriceRecommendations(inputs,args.accountSlug,expected.clock);
  throw Error("Unknown original cohort "+kind);
}

type OriginalCase = { kind:string; args:{accountSlug:string|null;days?:number}; value:any };
const originalCases:OriginalCase[] = expected.cases;
describe("captured analytics match independently frozen original query results",()=>{
  it.each(originalCases)("$kind / $args.accountSlug / $args.days",async(c)=>{
    const actual=await calculate(c.kind,c.args);
    expect(actual).toEqual(jsonToConvex(c.value));
    expect(JSON.stringify(convexToJson(actual as any))).toBe(JSON.stringify(c.value));
  });
  it("uses a complete real source fixture when explicitly configured",()=>{
    if(process.env.RM_SLOW_ANALYTICS_FIXTURE){expect(tables.reservations.length).toBeGreaterThan(4000);expect(tables.items.length).toBe(108);}
    expect(expected.cases).toHaveLength(50);
  });
});

function original(kind:string,account:string,days?:number){
  const c=expected.cases.find((c:any)=>c.kind===kind&&(c.args.accountSlug??"all")===account&&c.args.days===days);
  expect(c).toBeDefined();return jsonToConvex(c.value);
}

describe("real daily refresher routing",()=>{
  it("preserves every kind-breakdown write and order against the original collector input",async()=>{
    const cutoff=new Date(expected.clock-365*86400000).toISOString().slice(0,10);
    const reservations=tables.reservations.filter((r:any)=>typeof r.start_date==="string"&&Buffer.compare(Buffer.from(r.start_date),Buffer.from(cutoff))>=0)
      .sort((a:any,b:any)=>Buffer.compare(Buffer.from(a.start_date),Buffer.from(b.start_date))||a._creationTime-b._creationTime);
    const oldWrites:any[]=[],newWrites:any[]=[];
    const oldCtx:any={runQuery:async(ref:any)=>{expect(getFunctionName(ref)).toBe("mv/rental_volume_kind_breakdown:collectInputs");return {reservations,items:tables.items,pricing:tables.pricing_catalog,overrideRows:tables.listing_resolution_override};},runMutation:async(ref:any,args:any)=>oldWrites.push({path:getFunctionName(ref),args})};
    const newCtx:any={runQuery:async()=>{throw Error("Repeated kind-breakdown source query");},runMutation:async(ref:any,args:any)=>newWrites.push({path:getFunctionName(ref),args})};
    expect(await refreshKindBreakdown(newCtx,volumeInputs)).toEqual(await refreshKindBreakdown(oldCtx));
    expect(newWrites.length).toBeGreaterThan(0);expect(newWrites).toEqual(oldWrites);
    expect(JSON.stringify(convexToJson(newWrites))).toBe(JSON.stringify(convexToJson(oldWrites)));
  });
  it("uses real captured rows for all bundle, sell and price outputs and uses captured definitions without re-querying",async()=>{
    const calls:string[]=[];const writes:any[]=[];
    const ctx:any={runQuery:async(ref:any)=>{const path=getFunctionName(ref);calls.push(path);if(path==="mv/master:collectBundleInputs")return {bundles:tables.bundles,bundleItems:tables.bundle_items};if(path==="tax:__service_getTaxYearSummary")return {unchangedTaxRouting:true};throw Error("Unexpected repeated source query "+path);},runMutation:async(ref:any,args:any)=>{expect(getFunctionName(ref)).toBe("mv/widgets:writeWidget");writes.push(args);}};
    expect(await refreshSlowWidgets(ctx,widgetInputs)).toEqual({ok:true,written:29});
    expect(calls.filter(c=>c==="mv/master:collectBundleInputs")).toHaveLength(0);
    expect(calls.filter(c=>c==="tax:__service_getTaxYearSummary")).toHaveLength(4);
    for(const row of writes.filter(r=>!r.key.startsWith("tax:"))){const [kind,account,days]=row.key.split(":");expect(row.payload).toEqual(original(kind==="bundles"?kind:kind,account,days?Number(days):undefined));expect(row.generatedAt).toBe(expected.clock);}
  });
  it("keeps every legacy query fallback when no capture is supplied",async()=>{
    const calls:string[]=[];const ctx:any={runQuery:async(ref:any)=>{calls.push(getFunctionName(ref));return [];},runMutation:async()=>{}};
    expect(await refreshSlowWidgets(ctx)).toEqual({ok:true,written:29});expect(calls.filter(c=>c==="bundles:__service_getTopBundles")).toHaveLength(15);expect(calls).not.toContain("mv/master:collectBundleInputs");
  });
  it("writes all category, insight and investment rows from captured inputs without re-querying",async()=>{
    const writes:any[]=[];const ctx:any={runQuery:async()=>{throw Error("Repeated analytics query");},runMutation:async(ref:any,args:any)=>writes.push({path:getFunctionName(ref),...args})};
    expect((await refreshVolume(ctx,volumeInputs)).written).toBe(15);
    expect((await refreshInsights(ctx,inputs)).written).toBe(5);
    expect((await refreshScorecard(ctx,inputs)).written).toBe(5);
    for(const row of writes){const kind=row.path==="mv/rental_volume_by_category:write"?"volume":row.path==="mv/ai_insights:write"?"insights":"score";expect(row.payload).toEqual(original(kind,row.account,row.days));}
  });
  it("retains failure isolation at the first bundle slot after the original sell and price writes",async()=>{
    const writes:any[]=[];const ctx:any={runQuery:async()=>{throw Error("Definition read failed");},runMutation:async(_ref:any,args:any)=>writes.push(args)};
    await expect(refreshSlowWidgets(ctx,{...inputs,bundleDefinitions:{ok:false,error:"Definition read failed"}})).rejects.toThrow("Definition read failed");expect(writes.map(r=>r.key)).toEqual(["sell:all","price:all"]);
  });
});

describe("captured rows retain original index order",()=>{
  it("matches UTF-8 source ordering independently of locale or UTF-16",()=>{const strings=["2026-01-01","2026-01-02","\u{10000}","\ue000","é",""];expect([...strings].sort(compareSourceStrings)).toEqual([...strings].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));});
  it("keeps inclusive date boundaries and stable creation ties without mutating the source",()=>{const rows:any=[{_id:"old",_creationTime:1,start_date:"2026-01-01",status:"confirmed",account_slug:"leo"},{_id:"second",_creationTime:2,start_date:"2026-01-02",status:"confirmed",account_slug:"leo"},{_id:"first-tie",_creationTime:1,start_date:"2026-01-02",status:"completed",account_slug:"leo"},{_id:"second-tie",_creationTime:1,start_date:"2026-01-02",status:"completed",account_slug:"leo"},{_id:"missing",_creationTime:0,status:"confirmed",account_slug:"leo"}];freeze(rows);expect(startDateWindow(rows,"2026-01-02").map(r=>r._id)).toEqual(["first-tie","second-tie","second"]);expect(accountStatusRows(rows,"leo").map(r=>r._id)).toEqual(["first-tie","second-tie","missing","old","second"]);expect(rows[0]._id).toBe("old");});
});


describe("atomic encoded analytics snapshots",()=>{
  const metadata=()=>({items:tables.items,pricing:tables.pricing_catalog,capturedAt:expected.clock,bundleDefinitions:widgetInputs.bundleDefinitions,attributionOverrides:{ok:true as const,value:tables.listing_resolution_override}});
  async function encoded(){
    return Promise.all(tables.reservations.map(async(row:any,index:number)=>{
      const data=packCacheValue(row);
      return {_id:`record${index}`,_creationTime:index,source_id:row._id,source_creation_time:row._creationTime,version:1,valid:true,data,packed_sha256:await cacheByteDigest(data),source_sha256:"fixture",...reservationReadMetadata(row)};
    }));
  }
  function queryContext(records:any[]|undefined,brokenTable?:string){
    const reads:string[]=[];
    const all:any={...tables,reservation_read_gate:records?[{key:"full:v1",version:1,enabled:true,ready:true}]:[],reservation_read_records:records??[]};
    const db={query(table:string){
      if(table===brokenTable)throw Error("Optional table failed");
      let key="_creationTime";let filter:(row:any)=>boolean=()=>true;
      const q={withIndex(name:string,build?:(q:any)=>any){if(name==="by_source_creation_time")key="source_creation_time";const range={eq(field:string,value:any){filter=row=>row[field]===value;return range;}};build?.(range);return q;},async collect(){reads.push(table);return structuredClone([...(all[table]??[])].filter(filter).sort((a,b)=>(a[key]??0)-(b[key]??0)));},async unique(){const rows=await q.collect();if(rows.length>1)throw Error("Duplicate fixture state");return rows[0]??null;}};return q;}};
    return {ctx:{db}as any,reads};
  }
  it("captures all coupled tables in one query and defers optional errors without fabricating data",async()=>{
    const f=queryContext(undefined,"bundles");const result:any=await(capture as any)._handler(f.ctx,{forceSource:true});
    expect(result.mode).toBe("source");expect(result.reservations).toEqual(tables.reservations);expect(result.items).toEqual(tables.items);expect(result.bundleDefinitions).toEqual({ok:false,error:"Optional table failed"});expect(result.attributionOverrides.value).toEqual(tables.listing_resolution_override);expect(f.reads).not.toContain("reservation_read_records");
  });
  it("decodes complete real records in the action, preserving every row and its source order",async()=>{
    const records=await encoded();const f=queryContext(records);const carrier:any=await(capture as any)._handler(f.ctx,{});expect(carrier.mode).toBe("records");expect(f.reads).not.toContain("reservations");
    const ctx:any={runQuery:async(ref:any,args:any)=>{expect(getFunctionName(ref)).toBe("mv/slow_inputs:capture");expect(args).toEqual({});return carrier;}};
    const value=await loadSlowAnalyticsSnapshot(ctx);expect(value.reservations).toEqual(tables.reservations);expect(value.items).toEqual(tables.items);expect(value).not.toHaveProperty("records");expect(value).not.toHaveProperty("mode");
  });
  it("rejects ambiguous record order instead of selecting or clipping rows",async()=>{
    const rows=[{valid:true,version:1,source_id:"a",source_creation_time:1},{valid:true,version:1,source_id:"b",source_creation_time:1}];const f=queryContext(rows);expect((await(capture as any)._handler(f.ctx,{})).mode).toBe("fallback");expect(f.reads).not.toContain("reservations");
  });
  it("replaces the entire input snapshot after validation failure, with one source fallback",async()=>{
    const calls:any[]=[];const fresh={...metadata(),mode:"source",reservations:tables.reservations,items:[{...tables.items[0],qty:123}]};
    const ctx:any={runQuery:async(_ref:any,args:any)=>{calls.push(args);return calls.length===1?{...metadata(),mode:"records",records:[{valid:false}]}:fresh;}};
    const value=await loadSlowAnalyticsSnapshot(ctx);expect(calls).toEqual([{}, {forceSource:true}]);expect(value.items[0].qty).toBe(123);expect(value.reservations).toEqual(tables.reservations);
  });
  it("stops after one unavailable source fallback",async()=>{
    const calls:any[]=[];const ctx:any={runQuery:async(_ref:any,args:any)=>{calls.push(args);return {mode:"fallback",reason:"invalid optional set"};}};
    await expect(loadSlowAnalyticsSnapshot(ctx)).rejects.toThrow("Full source snapshot fallback was unavailable");expect(calls).toEqual([{}, {forceSource:true}]);
  });
});
