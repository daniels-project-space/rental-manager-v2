import { expect,it } from "vitest";
import { matchesBatteryListingRole } from "./power_listing_identity";
import { resolveListingComponents } from "./listing_components";

const battery={_id:"battery",name_canonical:"Sony NPF 970 batteries 2x sets",kind:"power",status:"active",is_marketing_only:false,qty:4};
it("rejects the real FZ100 listing's NP-F970 fallback without inventing stock",()=>{
 expect(matchesBatteryListingRole("Sony fz100 alpha camera batteries 2x set addon",battery)).toBe(false);
 const resolved=resolveListingComponents([battery] as any,undefined,"battery",1,undefined,undefined,"Sony fz100 alpha camera batteries 2x set addon");
 expect(resolved.components).toEqual([]);expect(resolved.owned).toBeNull();
});
it("keeps correct battery families and unrelated camera bodies",()=>{
 expect(matchesBatteryListingRole("2x NP-F970 Batteries with Dual Charger",battery)).toBe(true);
 expect(matchesBatteryListingRole("2x Sony np 970 batteries",battery)).toBe(true);
 expect(matchesBatteryListingRole("Sony NP-FW50 batteries",battery)).toBe(false);
 expect(matchesBatteryListingRole("Sony NP-FZ100 batteries",{name_canonical:"Sony FX3",kind:"camera"})).toBe(true);
 expect(matchesBatteryListingRole("NP-FZ100 batteries",{name_canonical:"Sony batteries",kind:"power",aliases:["Sony NP-FZ100"]})).toBe(true);
});
