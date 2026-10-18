import {describe,it,expect,vi,beforeEach} from "vitest";
import {getFunctionName} from "convex/server";
const {getOrder}=vi.hoisted(()=>({getOrder:vi.fn()}));
vi.mock("../src/hygglo-core",async original=>({...await original<any>(),createHyggloCore:vi.fn(()=>({getOrder}))}));
import {refresh} from "./hygglo_history_actions";
function fixture(context:any={account:"diogo",state:null},claimed=true){
 const calls:Array<{name:string;args:any}>=[];
 const ctx:any={runQuery:vi.fn(async()=>context),runMutation:vi.fn(async(ref:any,args:any)=>{const name=getFunctionName(ref);calls.push({name,args});return name.endsWith(":claim")?claimed:true;})};return {ctx,calls};
}
beforeEach(()=>{getOrder.mockReset();});
describe("on-demand provider history refresh",()=>{
 it("requires a server-linked account and coalesces concurrent refreshes",async()=>{
  expect(await(refresh as any)._handler(fixture(null).ctx,{thread_id:"x"})).toMatchObject({ok:false});
  expect(await(refresh as any)._handler(fixture(undefined,false).ctx,{thread_id:"x"})).toMatchObject({ok:true,cached:true});expect(getOrder).not.toHaveBeenCalled();
 });
 it("imports every provider activity in bounded pages and completes after all pages",async()=>{
  const f=fixture();getOrder.mockResolvedValue({id:123,isBookedAndReady:true,steps:[{key:"RETURNED",active:true}],activities:Array.from({length:125},(_,i)=>({key:`chat-${i}`,chatMessage:{text:{content:`Message ${i}`},byMe:false}}))});
  expect(await(refresh as any)._handler(f.ctx,{thread_id:"123"})).toEqual({ok:true});
  const pages=f.calls.filter(c=>c.name.endsWith(":writePage"));expect(pages.map(p=>p.args.entries.length)).toEqual([40,40,40,5]);expect(f.calls.at(-1)?.name).toBe("hygglo_history:complete");expect(f.calls.at(-1)?.args.proof.platform_booking_confirmed).toBe(true);
  expect(f.calls.every(c=>c.name.startsWith("hygglo_history:"))).toBe(true);
 });
 it("rejects a mismatched provider order before writing another conversation",async()=>{
  const f=fixture();getOrder.mockResolvedValue({id:999,activities:[]});expect(await(refresh as any)._handler(f.ctx,{thread_id:"123"})).toMatchObject({ok:false});expect(f.calls.some(c=>c.name.endsWith(":writePage"))).toBe(false);expect(f.calls.at(-1)?.name).toBe("hygglo_history:failed");
 });
 it("preserves existing history if the provider is unavailable",async()=>{
  const f=fixture();getOrder.mockImplementation(async()=>{throw new Error("Temporary provider error")});
  const result=await(refresh as any)._handler(f.ctx,{thread_id:"123"});
  expect(result).toMatchObject({ok:false});
  expect(f.calls.some(c=>c.name.endsWith(":complete"))).toBe(false);
  expect(f.calls.at(-1)?.name).toBe("hygglo_history:failed");
 });
});
