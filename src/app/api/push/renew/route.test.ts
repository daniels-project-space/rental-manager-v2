import {beforeEach,afterEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({getToken:vi.fn(),mutation:vi.fn(),setAdminAuth:vi.fn()}));
vi.mock("@/lib/auth-server",()=>({getToken:mocks.getToken}));
vi.mock("convex/browser",()=>({ConvexHttpClient:class{mutation=mocks.mutation;setAdminAuth=mocks.setAdminAuth;}}));
import {POST} from "./route";
const body=()=>({endpoint:"https://push.test/new",previous_endpoint:"https://push.test/old",p256dh:"public",auth:"auth",renewal_credential:"a".repeat(64)});
const request=(value:unknown)=>new Request("https://rental.test/api/push/renew",{method:"POST",headers:{cookie:"expired-owner-session"},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("OWNER_AUTH_REQUIRED","true");vi.stubEnv("CONVEX_URL","https://hearty-oyster-600.convex.cloud");vi.stubEnv("CONVEX_DEPLOY_KEY","test-only-service-key");});
afterEach(()=>vi.unstubAllEnvs());
it("uses a device capability with expired cookies and never forwards activation/preferences",async()=>{
 mocks.mutation.mockResolvedValue({active:true,status:"updated",mode:"my_share"});
 const result=await POST(request({...body(),activate:true,mode:"all"}));expect(result.status).toBe(200);
 expect(mocks.getToken).not.toHaveBeenCalled();expect(mocks.setAdminAuth).toHaveBeenCalled();expect(mocks.mutation.mock.calls[0][1]).toEqual(body());
 expect(await result.json()).toEqual({ok:true,active:true,status:"updated",mode:"my_share"});
});
it("denies an unrecognised capability rather than bypassing its Native check",async()=>{
 mocks.mutation.mockResolvedValue({active:false,status:"inactive"});expect((await POST(request(body()))).status).toBe(403);
});
it("exposes the renewal-required result without authorizing the dead endpoint",async()=>{
 mocks.mutation.mockResolvedValue({active:false,status:"renewal_required",mode:"my_share"});expect((await POST(request(body()))).status).toBe(409);
});
it("rejects missing, malformed and oversized credential input before the mutation",async()=>{
 for(const value of [{},{...body(),renewal_credential:"wrong"},{...body(),endpoint:"x".repeat(4097)},null])expect((await POST(request(value))).status).toBeGreaterThanOrEqual(400);
 expect(mocks.mutation).not.toHaveBeenCalled();
});
it("does not expose credentials or backend exception text during an outage",async()=>{
 mocks.mutation.mockRejectedValue(new Error("private backend details"));const result=await POST(request(body()));expect(result.status).toBe(503);expect(await result.json()).toEqual({ok:false,error:"renewal_failed"});
});
