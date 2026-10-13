import {describe,it,expect} from "vitest";
import {receive} from "./storefront_checkout_stock";
const invoke=(ctx:any,a:any)=>(receive as any)._handler(ctx,a);
describe("authenticated website hold stock receiver",()=>{
 it("validates every physical row atomically and fences delayed snapshots",async()=>{
  let current:any=null;
  const ctx:any={db:{normalizeId:(_table:string,id:string)=>id==="stock95"?id:null,get:async(id:string)=>id==="stock95"?{_id:id}:null,query:()=>({withIndex:()=>({unique:async()=>current})}),insert:async(_table:string,row:any)=>{current={...row,_id:"snapshot"};return "snapshot"},patch:async(_id:string,row:any)=>Object.assign(current,row)}};
  const revision=Date.now(),row={bookingId:"pending",masterItemId:"stock95",start:revision+86400000,end:revision+90000000,qty:2,expiresAt:revision+600000,endExclusive:true,bufferMinutes:60};
  await expect(invoke(ctx,{revision,rows:[row,{...row,masterItemId:"foreign"}]})).rejects.toThrow();expect(current).toBeNull();
  expect(await invoke(ctx,{revision,rows:[row]})).toEqual({ok:true,revision});expect(current.rows[0].item_id).toBe("stock95");expect(current.rows[0]).not.toHaveProperty("masterItemId");
  await invoke(ctx,{revision:revision-1,rows:[]});expect(current.rows).toHaveLength(1);
  await invoke(ctx,{revision:revision+1,rows:[]});expect(current.rows).toHaveLength(0);
  await expect(invoke(ctx,{revision:revision+2,rows:[{...row,qty:0}]})).rejects.toThrow();expect(current.rows).toHaveLength(0);
 });
});
