import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerRecoveryConfig, ownerRecoveryLink, sendOwnerRecovery } from "./owner_recovery";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv("SITE_URL", "https://rental-manager-v2-nu.vercel.app");
  vi.stubEnv("OWNER_RECOVERY_RESEND_API_KEY", "re_controlled_test_key");
  vi.stubEnv("OWNER_RECOVERY_FROM", "Rental Manager <access@dbcinemarentals.com>");
}
describe("owner recovery email boundary", () => {
  it("rejects missing/foreign/injected sender and unsafe origins before provider traffic", () => {
    expect(() => ownerRecoveryConfig()).toThrow("unavailable");
    configure(); expect(ownerRecoveryConfig().origin).toBe("https://rental-manager-v2-nu.vercel.app");
    vi.stubEnv("OWNER_RECOVERY_FROM", "test@other-project.com"); expect(() => ownerRecoveryConfig()).toThrow("unavailable");
    vi.stubEnv("OWNER_RECOVERY_FROM", "test\n@dbcinemarentals.com"); expect(() => ownerRecoveryConfig()).toThrow("unavailable");
    configure(); vi.stubEnv("SITE_URL", "http://public.example"); expect(() => ownerRecoveryConfig()).toThrow("unavailable");
    vi.stubEnv("SITE_URL", "https://user:pass@private.example"); expect(() => ownerRecoveryConfig()).toThrow("unavailable");
  });
  it("keeps token in fragment and preserves only safe local destinations", () => {
    const origin="https://rental-manager-v2-nu.vercel.app",token="controlled-reset-token-24";
    const callback=origin+"/login?returnTo="+encodeURIComponent("/renter-bot-lab?chat=42#messages");
    const link=new URL(ownerRecoveryLink(origin,token,origin+"/api/auth/reset-password/"+token+"?callbackURL="+encodeURIComponent(callback)));
    expect(link.pathname).toBe("/login"); expect(link.searchParams.has("token")).toBe(false);
    expect(link.searchParams.get("returnTo")).toBe("/renter-bot-lab?chat=42#messages");
    expect(new URLSearchParams(link.hash.slice(1)).get("reset")).toBe(token);
    expect(()=>ownerRecoveryLink(origin,token,"https://example.test/?callbackURL="+encodeURIComponent("https://evil.test/login"))).toThrow("destination");
    expect(()=>ownerRecoveryLink(origin,"<injected>",origin)).toThrow("token");
    expect(new URL(ownerRecoveryLink(origin,token,origin+"/?callbackURL="+encodeURIComponent(origin+"/login?returnTo=https://evil.test"))).search).toBe("");
  });
  it("requires real provider acknowledgement and uses token-bound opaque idempotency", async () => {
    configure(); const calls: RequestInit[]=[];
    vi.stubGlobal("fetch",vi.fn(async (_url,init)=>{calls.push(init);return new Response(JSON.stringify({id:"controlled-provider-receipt"}),{status:200});}));
    await sendOwnerRecovery("owner@example.invalid","controlled-reset-token-24","https://rental-manager-v2-nu.vercel.app/api/auth/reset-password/token");
    const body=JSON.parse(String(calls[0].body)),headers=calls[0].headers as Record<string,string>;
    expect(body.to).toEqual(["owner@example.invalid"]);expect(body.html).toContain("15 minutes");
    expect(body.text).toContain("#reset=controlled-reset-token-24");
    expect(headers["Idempotency-Key"]).toMatch(/^rm-owner-reset-[a-f0-9]{64}$/);
    expect(headers["Idempotency-Key"]).not.toContain("controlled-reset-token");
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{"message":"provider secret should never surface"}',{status:503})));
    await expect(sendOwnerRecovery("owner@example.invalid","controlled-reset-token-24","https://rental-manager-v2-nu.vercel.app/")).rejects.toThrow("temporarily unavailable");
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('{}',{status:200})));
    await expect(sendOwnerRecovery("owner@example.invalid","controlled-reset-token-24","https://rental-manager-v2-nu.vercel.app/")).rejects.toThrow("could not be confirmed");
  });
});
