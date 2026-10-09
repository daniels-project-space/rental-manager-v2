import { afterEach, expect, it, vi } from "vitest";
import { claimRecoveryToken, reserveRecoveryMail } from "./owner_access";
afterEach(()=>vi.useRealTimers());
it("actual atomic handler denies foreign identities and bounds owner email attempts across IPs/windows",async()=>{
 vi.useFakeTimers();vi.setSystemTime(100_000);
 let owner:any={_id:"singleton",auth_user_id:"owner",email:"owner@example.invalid"};
 const patch=vi.fn(async(_id,values)=>Object.assign(owner,values));
 const ctx={db:{query:()=>({first:async()=>owner}),patch}};
 const reserve=(id="owner",email="owner@example.invalid",hash="a".repeat(64))=>(reserveRecoveryMail as any)._handler(ctx,{auth_user_id:id,email,token_hash:hash});
 expect(await reserve("foreign")).toBe(false);expect(await reserve("owner","foreign@example.invalid")).toBe(false);expect(patch).not.toHaveBeenCalled();
 expect(await reserve()).toBe(true);expect(await reserve()).toBe(false);
 expect(await (claimRecoveryToken as any)._handler(ctx,{token_hash:"b".repeat(64)})).toBe(false);
 expect(await (claimRecoveryToken as any)._handler(ctx,{token_hash:"a".repeat(64)})).toBe(true);
 expect(await (claimRecoveryToken as any)._handler(ctx,{token_hash:"a".repeat(64)})).toBe(false);
 for(let i=0;i<4;i++){vi.advanceTimersByTime(60_000);expect(await reserve()).toBe(true);}
 vi.advanceTimersByTime(60_000);expect(await reserve()).toBe(false);expect(owner.recovery_mail_window_count).toBe(5);
 vi.setSystemTime(3_700_000);expect(await reserve()).toBe(true);expect(owner.recovery_mail_window_count).toBe(1);
 vi.advanceTimersByTime(900_000);expect(await (claimRecoveryToken as any)._handler(ctx,{token_hash:"a".repeat(64)})).toBe(false);
 owner=null;expect(await reserve()).toBe(false);
});
