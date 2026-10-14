import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { resolveListingComponents } from "../lib/listing_components";

const aliases = ["DJI RS3 Pro Gimbal Batteries", "DJI RS3 Pro batteries", "DJI Ronin RS2 RS3 Pro Gimbal Battery", "DJI RS BG30 grip battery"];
const targets = [
  { account: "dbcinema", product: 856455, qty: 1 },
  { account: "dbcinema", product: 856472, qty: 2 },
  { account: "diogo", product: 1173490, qty: 1 },
  { account: "diogo", product: 1173716, qty: 2 },
];
const note = "Reviewed BG30 spare battery identity, 14 Oct 2026: existing inventory records three DJI RS BG30 grip batteries. Spare battery listings consume this pool, never complete gimbals. No stock quantity, external listing or rental changed.";

/** Atomic catalogue correction only; default preview performs no writes. */
export const apply = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    // One-off bounded inventory audit, never used by a reactive client query.
    const items = await ctx.db.query("items").take(1000);
    if (items.length === 1000) throw Error("Inventory audit bound reached");
    const batteries = items.filter(i => i.battery_type === "DJI RS BG30 grip battery");
    if (batteries.length !== 1) throw Error("BG30 physical identity is ambiguous");
    const battery = batteries[0];
    if (String(battery._id) !== "kn79kzg6j393vz9mjh7ghqx0gn86bz73" || battery.name_canonical !== "DJI gimbal battery" || battery.kind !== "power" || battery.qty !== 3 || battery.status !== "active" || battery.is_marketing_only) throw Error("BG30 inventory changed; review required");
    const nextAliases = [...new Set([...(battery.aliases ?? []), ...aliases])];
    const nextItems = items.map(i => i._id === battery._id ? { ...i, aliases: nextAliases, track_independent_stock: true } : i);
    const plans = [];
    for (const target of targets) {
      const products = await ctx.db.query("hygglo_products").withIndex("by_account_product", q => q.eq("accountSlug", target.account).eq("productId", target.product)).take(2);
      if (products.length !== 1) throw Error("Spare listing identity changed");
      const product = products[0];
      const expectedLine = new RegExp(`\\b${target.qty}x\\s+DJI[^\\n]*batter(?:y|ies)`, "i");
      if (!expectedLine.test(product.description ?? "") || !/batter/i.test(product.name ?? "")) throw Error("Spare listing contents changed");
      const components = [{ item_id: battery._id, qty: target.qty }];
      const rows = await ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", target.account).eq("product_id", target.product)).take(2);
      if (rows.length > 1 || rows[0] && (rows[0].source !== "manual_audit" || rows[0].note !== note || JSON.stringify(rows[0].components) !== JSON.stringify(components))) throw Error("Existing manual mapping requires review");
      const resolved = resolveListingComponents(nextItems, components, product.masterItemId, 1, product.description, undefined, product.name);
      if (!resolved.complete || !resolved.owned || resolved.components.length !== 1 || resolved.components[0].item_id !== String(battery._id) || resolved.components[0].units_per_listing !== target.qty || !resolved.components[0].stock_required) throw Error("Spare stock identity did not resolve exclusively to BG30 batteries");
      plans.push({ ...target, components, existing: rows[0]?._id });
    }
    const metadataChanged = battery.track_independent_stock !== true || JSON.stringify(nextAliases) !== JSON.stringify(battery.aliases ?? []);
    const inserted = plans.filter(p => !p.existing).length;
    if (args.dry_run !== false) return { preview: true, metadataChanged, inserted, plans, quantityOwned: battery.qty };
    if (metadataChanged) await ctx.db.patch(battery._id, { aliases: nextAliases, track_independent_stock: true });
    for (const plan of plans) if (!plan.existing) await ctx.db.insert("listing_resolution_override", { account_slug: plan.account, product_id: plan.product, components: plan.components, source: "manual_audit", note, updated_at: Date.now() });
    if (metadataChanged || inserted) {
      await ctx.db.insert("audit_log", { table_name: "items/listing_resolution_override", actor: "catalogue-audit", op: "update", count: Number(metadataChanged) + inserted, source_file: "seed/bg30_stock_repair.apply", note, ts: Date.now() });
      const settings = await ctx.db.query("settings").first();
      if (settings) await ctx.db.patch(settings._id, { draft_epoch: (settings.draft_epoch ?? 0) + 1 });
    }
    return { preview: false, metadataChanged, inserted, quantityOwned: battery.qty };
  },
});
