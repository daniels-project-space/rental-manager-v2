import { describe, it, expect } from "vitest";
import { replacementSets } from "./replacement_sets";
import { executeNativeBasketSwap, basketSwapSnapshot } from "./quick_reply_swap";

describe("complete replacement sets",()=>{
  it("qualifies all unavailable replacements together, retaining the rest of the kit",async()=>{
    const calls:string[][]=[];
    const result=await replacementSets([["camera1","camera2"],["lens1","lens2"]],item=>item,async set=>{calls.push(["retained tripod",...set]);return set.join("|")!=="camera1|lens1";});
    expect(result.sets).toEqual([["camera1","lens2"],["camera2","lens1"]]);
    expect(calls).toEqual([["retained tripod","camera1","lens1"],["retained tripod","camera1","lens2"],["retained tripod","camera2","lens1"]]);
  });
  it("never returns a partial set when any line has no available substitute",async()=>{expect((await replacementSets([["camera"],[]],x=>x,async()=>true)).sets).toEqual([]);});
  it("checks shared inventory jointly instead of assuming independent candidates fit",async()=>{expect((await replacementSets([["body"],["kit"]],x=>x,async()=>false)).sets).toEqual([]);});
  it("bounds search and reports that it stopped",async()=>{const result=await replacementSets([[1,2,3],[4,5,6]],String,async()=>false,2,2);expect(result.limited).toBe(true);expect(result.sets).toEqual([]);});
});
function fixture() {
  let items=[{item_id:11,product_id:21,name:"Camera",can_remove:true},{item_id:12,product_id:22,name:"Lens",can_remove:true},{item_id:13,product_id:23,name:"Tripod",can_remove:true}];
  const original={account_slug:"dbcinema",start:"2026-10-14",end:"2026-10-17",items:structuredClone(items)};
  const calls:string[]=[];
  const io={read:async()=>({ok:true,actions:{add_product:true},dates:{start:original.start,end:original.end},items:structuredClone(items)}),add:async(productId:number)=>{calls.push(`add:${productId}`);items.push({item_id:100+productId,product_id:productId,name:"Replacement",can_remove:true});return {status:"sent"};},remove:async(id:number)=>{calls.push(`remove:${id}`);items=items.filter(item=>item.item_id!==id);return {status:"sent"};}};
  return {io,original,calls,items:()=>items};
}
const swaps=[{oldId:11,newProductId:31},{oldId:12,newProductId:32}];
describe("native complete-set execution safety",()=>{
  it("adds and verifies every substitute before removing any original",async()=>{const f=fixture();expect(await executeNativeBasketSwap(f.io,swaps,f.original)).toEqual({ok:true,state:"applied"});expect(f.calls).toEqual(["add:31","add:32","remove:11","remove:12"]);expect(f.items().map(item=>item.product_id)).toEqual([23,31,32]);});
  it("never removes an original after an uncertain addition",async()=>{const f=fixture();f.io.add=async()=>{throw Error("timeout")};expect((await executeNativeBasketSwap(f.io,swaps,f.original)).state).toBe("attention");expect(f.calls).toEqual([]);expect(f.items()).toHaveLength(3);});
  it("keeps all originals when the second addition cannot be proved",async()=>{const f=fixture();const add=f.io.add;f.io.add=async id=>id===32?{status:"failed"}:add(id);expect((await executeNativeBasketSwap(f.io,swaps,f.original)).state).toBe("attention");expect(f.calls).toEqual(["add:31"]);expect(f.items().filter(item=>item.item_id<100)).toHaveLength(3);});
  it("recovers proven additions on a definitively skipped second addition",async()=>{const f=fixture();const add=f.io.add;f.io.add=async id=>id===32?{status:"skipped"}:add(id);expect((await executeNativeBasketSwap(f.io,swaps,f.original)).state).toBe("failed");expect(f.calls).toEqual(["add:31","remove:131"]);expect(f.items()).toHaveLength(3);});
  it("rejects changed basket before any write",async()=>{const f=fixture();f.original.items[2].name="Changed";expect((await executeNativeBasketSwap(f.io,swaps,f.original)).state).toBe("failed");expect(f.calls).toEqual([]);});
  it("stops after uncertain removal and keeps the complete new set",async()=>{const f=fixture();f.io.remove=async()=>{throw Error("timeout")};expect((await executeNativeBasketSwap(f.io,swaps,f.original)).state).toBe("attention");expect(f.items().map(item=>item.product_id)).toEqual([21,22,23,31,32]);});
  it("canonical snapshots ignore JSON property order",()=>{expect(basketSwapSnapshot({items:[],lines:[{lineIndex:1,listingId:"a",qty:1,start:1,end:2}]},"b")).toBe(basketSwapSnapshot({lines:[{end:2,start:1,qty:1,listingId:"a",lineIndex:1}],items:[]},"b"));});
});
