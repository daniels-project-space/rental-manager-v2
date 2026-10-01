import { internalMutation } from "./_generated/server";

export const run = internalMutation({ args: {}, handler: async ctx => {
  const items = await ctx.db.query("items").collect();
  const identity = new Map<string, Set<string>>();
  for (const i of items) for (const name of [i.name_canonical, i.name_input, ...(i.aliases ?? [])]) {
    const key = name.trim().toLowerCase(), names = identity.get(key) ?? new Set();
    names.add(i.name_canonical); identity.set(key, names);
  }
  // Existing owner-maintained inventory uses Wh; these legacy compatibility
  // labels are spelling/unit mistakes, not a conversion of battery capacity.
  for (const capacity of [95, 150]) {
    const current = items.find(i => i.name_canonical === `V-mount ${capacity}Wh`);
    if (current) identity.set(`v-mount ${capacity}mah`, new Set([current.name_canonical]));
  }
  const compatibilityChanges: Array<{ item: string; field: string; before: string; after: string }> = [];
  for (const i of items) {
    if (!i.compatibility) continue;
    const compatibility = { ...i.compatibility };
    let changed = false;
    for (const field of ["batteries", "cards", "lenses", "accessories"] as const) {
      const values = compatibility[field]; if (!values) continue;
      compatibility[field] = values.map(value => {
        const names = identity.get(value.trim().toLowerCase());
        const current = names?.size === 1 ? [...names][0] : value;
        if (current !== value) { changed = true; compatibilityChanges.push({ item: i.name_canonical, field, before: value, after: current }); }
        return current;
      });
    }
    if (changed) await ctx.db.patch(i._id, { compatibility, updated_at: Date.now() });
  }
  // Exact audit finding: this listing's authoritative map contains A7 II +
  // 28–70mm, but the old primary index points to the lens. Keep the full map.
  const mapping = await ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", "dbcinema").eq("product_id", 936041)).unique();
  const cameras = mapping?.components.map(c => items.find(i => i._id === c.item_id)).filter(i => i?.kind === "camera") ?? [];
  if (cameras.length !== 1 || cameras[0]?.name_canonical !== "Sony A7 II") throw new Error("Authoritative listing identity changed; review before repairing the primary index");
  const index = await ctx.db.query("hygglo_product_index").withIndex("by_account_product", q => q.eq("account_slug", "dbcinema").eq("product_id", 936041)).unique();
  if (!index) throw new Error("Missing audited primary index");
  const previousPrimary = index.item_id;
  await ctx.db.patch(index._id, { item_id: cameras[0]._id });
  return { compatibilityChanges, primaryIndex: { account: "dbcinema", product_id: 936041, previous: previousPrimary, current: cameras[0]._id } };
} });
