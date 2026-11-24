import { describe, expect, it, vi } from "vitest";

vi.mock("./owner_functions", () => ({
  mutation: (definition: unknown) => definition,
  query: (definition: unknown) => definition,
  requireOwner: async (ctx: any) => { if (!ctx.owner) throw Error("Unauthorized"); },
}));

import { getComponentReplacements, setComponentReplacements, setOverride } from "./listing_overrides";

function fixture() {
  const rows = new Map<string, any>();
  const mapping = { _id: "mapping", account_slug: "dbcinema", product_id: 42, components: [{ item_id: "body", qty: 1 }, { item_id: "old", qty: 1 }], updated_at: 1 };
  rows.set("mapping", { ...mapping, table: "listing_resolution_override" });
  for (const id of ["body", "old", "new"]) rows.set(id, { _id: id, table: "items", name_canonical: id, status: "active", is_marketing_only: false, qty: 2, replacement_cost_gbp: 1000 });
  rows.set("product", { _id: "product", table: "hygglo_products", accountSlug: "dbcinema", productId: 42 });
  rows.set("listing", { _id: "listing", table: "online_listings", account_slug: "dbcinema", product_id: 42, public_url: "https://example.invalid/listing", description: "Includes 16–35mm f/4 lens" });
  const db = {
    get: async (id: string) => rows.get(id) ?? null,
    patch: async (id: string, patch: any) => { rows.set(id, { ...rows.get(id), ...patch }); },
    insert: async (table: string, data: any) => { const id = `${table}-${rows.size}`; rows.set(id, { ...data, _id: id, table }); return id; },
    query: (table: string) => {
      const conditions: Array<[string, unknown]> = [];
      const query: any = { withIndex: (_: string, fn: any) => { const selector: any = { eq: (key: string, value: unknown) => { conditions.push([key, value]); return selector; } }; fn(selector); return query; },
        collect: async () => [...rows.values()].filter(row => row.table === table && conditions.every(([key, value]) => row[key] === value)),
        first: async () => (await query.collect())[0] ?? null };
      return query;
    },
  };
  return { ctx: { db, owner: true, auth: { getUserIdentity: async () => ({ subject: "owner" }) } }, rows };
}

describe("reviewed component substitutions", () => {
  it("requires owner review and current listing revision, and never enables checkout", async () => {
    const { ctx, rows } = fixture();
    const rule = { original_item_id: "old", replacement_item_id: "new", qty: 1, price_adjustment_pence: 500, extension_adjustment_pence: Array.from({length:30}, (_, index) => (index + 1) * 100), replacement_size_score: 2,
      weights: [{ item_id: "body", weight_grams: 1000 }, { item_id: "old", weight_grams: 600 }, { item_id: "new", weight_grams: 800 }], review_note: "Compatible GM lens checked" };
    const args = { account_slug: "dbcinema", product_id: 42, expected_revision: JSON.stringify(rows.get("mapping")), replacements: [rule] };
    await expect((setComponentReplacements as any).handler({ ...ctx, owner: false }, args)).rejects.toThrow("Unauthorized");
    await expect((setComponentReplacements as any).handler(ctx, { ...args, expected_revision: "stale" })).rejects.toThrow("mapping changed");
    await expect((setComponentReplacements as any).handler(ctx, { ...args, replacements: [{ ...rule, weights: rule.weights.slice(0, 2) }] })).rejects.toThrow("weight");
    await expect((setComponentReplacements as any).handler(ctx, { ...args, replacements: [{ ...rule, extension_adjustment_pence: [100] }] })).rejects.toThrow("price");
    await expect((setComponentReplacements as any).handler(ctx, { ...args, replacements: [{ ...rule, extension_adjustment_pence: Array(30).fill(0.5) }] })).rejects.toThrow("price");
    expect(await (setComponentReplacements as any).handler(ctx, args)).toEqual({ reviewed: 1, checkoutAvailable: false });
    expect(rows.get("mapping").component_replacements[0]).toMatchObject(rule);
    expect([...rows.values()].some(row => row.table === "audit_log")).toBe(true);
    await expect((getComponentReplacements as any).handler({ ...ctx, owner: false }, args)).rejects.toThrow("Unauthorized");
    expect((await (getComponentReplacements as any).handler(ctx, args)).replacements).toHaveLength(1);
    const revision = JSON.stringify(rows.get("mapping"));
    await (setOverride as any).handler(ctx, { account_slug: "dbcinema", product_id: 42, components: [{ item_id: "body", qty: 1 }], expected_revision: revision });
    expect(rows.get("mapping").component_replacements).toBeUndefined();
    const missing = { missing_original: { descriptor_id: "declared:lens-f4", label: "16–35mm f/4 lens", quantity: 1, source_url: "https://example.invalid/listing", source_excerpt: "Includes 16–35mm f/4 lens" }, replacement_item_id: "new", qty: 1, price_adjustment_pence: 500, replacement_size_score: 2,
      weights: [{ item_id: "body", weight_grams: 1000 }, { item_id: "new", weight_grams: 800 }], review_note: "Original and replacement checked" };
    const next = { account_slug: "dbcinema", product_id: 42, expected_revision: JSON.stringify(rows.get("mapping")), replacements: [missing] };
    await expect((setComponentReplacements as any).handler(ctx, { ...next, replacements: [{ ...missing, missing_original: { ...missing.missing_original, source_excerpt: "" } }] })).rejects.toThrow("substitution");
    expect(await (setComponentReplacements as any).handler(ctx, next)).toEqual({ reviewed: 1, checkoutAvailable: false });
    expect(rows.get("mapping").component_replacements[0].missing_original).toEqual(missing.missing_original);
  });
});
