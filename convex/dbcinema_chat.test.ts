import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { inbox } from "./dbcinema_chat";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const stock = { available: true, availableUnits: 2, ownedUnits: 2, requestedQty: 1 };
async function read(items: unknown[], proof = {}) {
  vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
  vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
  vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    expect(JSON.parse(String(options.body)).path).toBe("rentalChat:adminInbox");
    return new Response(JSON.stringify({status:"success",value:{authorized:true,items:[{
      _id:"fixture-booking",accountId:"fixture-person",name:"Fixture renter",lastMessage:"Is this available?",
      lastSender:"renter",createdAt:1,updatedAt:99,items,status:"pending_payment",...proof,
    }]}}));
  });
  vi.stubGlobal("fetch", fetchMock);
  const rows = await (inbox as any)._handler({runQuery:vi.fn(async()=>[])}, {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return rows[0];
}
describe("website Quick Reply full-basket stock and lifecycle",()=>{
  it("requires every item to be checked before displaying available",async()=>{
    const row=await read([{name:"Camera",stockAvailability:stock},{name:"Lens"}]);
    expect(row.availability).toMatchObject({status:"unknown",reason:"Full basket needs a stock review"});
    expect(row.availability.checked_at).toBeGreaterThan(0);
    expect(row.request_created_at).toBe(1);
    expect(row.last_activity_at).toBe(99);
    expect(row.availability.items).toHaveLength(2);
    expect(row.availability.items[1]).toMatchObject({item_index:1,name:"Lens",available:null});
  });
  it("preserves a verified conflict even when another line is unchecked",async()=>{
    expect((await read([{name:"Camera",stockAvailability:{...stock,available:false}},{name:"Lens"}])).availability.status).toBe("conflict");
  });
  it("reports available only for a fully checked basket",async()=>{
    expect((await read([{name:"Camera",stockAvailability:stock},{name:"Lens",stockAvailability:stock}])).availability.status).toBe("available");
  });
  it("keeps a basket with no stock results unknown",async()=>{
    expect((await read([{name:"Camera"}])).availability.status).toBe("unknown");
  });
  it("does not promote unpaid website enquiries",async()=>{
    expect(await read([], {idVerifyStatus:"verified",verificationUpdatedAt:1,verificationArchiveReady:true})).toMatchObject({paid:false,platform_booking_confirmed:false});
  });
  it("requires dated verification start and archive proof to confirm",async()=>{
    expect(await read([], {status:"confirmed",idVerifyStatus:"processing"})).toMatchObject({paid:true,verification_started:false,platform_booking_confirmed:false});
    expect(await read([], {status:"confirmed",idVerifyStatus:"processing",verificationUpdatedAt:1})).toMatchObject({verification_started:true,platform_booking_confirmed:false});
    expect(await read([], {status:"confirmed",idVerifyStatus:"verified",verificationUpdatedAt:1,verificationArchiveReady:true})).toMatchObject({platform_booking_confirmed:true});
  });
});
