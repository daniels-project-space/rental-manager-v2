import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { listForReconcile } from "./items";
afterEach(() => vi.unstubAllEnvs());
describe("actual storefront master-stock projection", () => {
  it("carries current quantities and rental eligibility without inventing defaults", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const rows = [
      {_id:"owned",name_canonical:"Sony FX3",aliases:["FX3"],qty:2,status:"active",is_marketing_only:false},
      {_id:"zero",name_canonical:"Sony A7 V",qty:0,status:"active",is_marketing_only:false},
      {_id:"retired",name_canonical:"Retired body",qty:5,status:"inactive",is_marketing_only:false},
      {_id:"marketing",name_canonical:"Marketing body",qty:1,status:"active",is_marketing_only:true,private_notes:"Private owner note"},
    ];
    const result = await (listForReconcile as any)._handler({db:{query:(table:string)=>{expect(table).toBe("items");return {collect:async()=>rows}}}},{});
    expect(result.map((r:any)=>[r._id,r.qty,r.status,r.is_marketing_only])).toEqual([
      ["owned",2,"active",false],["zero",0,"active",false],["retired",5,"inactive",false],["marketing",1,"active",true],
    ]);
    expect(result[0]).toMatchObject({name:"Sony FX3",aliases:["FX3"]});
    expect(result[3]).not.toHaveProperty("private_notes");
  });
  it("preserves the real owner boundary when enforcement is enabled", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    const read=vi.fn();
    await expect((listForReconcile as any)._handler({auth:{getUserIdentity:async()=>null},db:{query:read}},{})).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(read).not.toHaveBeenCalled();
  });
});
