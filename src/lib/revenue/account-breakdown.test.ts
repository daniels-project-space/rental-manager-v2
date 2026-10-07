import { describe, expect, it } from "vitest";
import { applyCurrentAccountRevenue } from "./account-breakdown";
describe("current revenue chart refresh", () => {
  const by = { dbcinema: 250, dbcinema_web: 80, leo: 120, diogo: 30 };
  it("keeps the website's own series and preserves the aggregate", () => { const result = applyCurrentAccountRevenue(by, null); expect(result.dbcinemaOrganic).toBe(250); expect(result.dbcinemaWebOrganic).toBe(80); expect(Object.values(result).reduce((n, v) => n + v, 0)).toBe(480); });
  it("cannot inject other accounts into a filtered chart refresh", () => { expect(applyCurrentAccountRevenue(by, "dbcinema_web")).toEqual({ dbcinemaOrganic: 0, dbcinemaWebOrganic: 80, leoOrganic: 0, diogoOrganic: 0 }); expect(applyCurrentAccountRevenue(by, "dbcinema").dbcinemaWebOrganic).toBe(0); });
});
