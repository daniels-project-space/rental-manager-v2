import type { QueryCtx } from "../_generated/server";
import { getLabOrder } from "./renter_booking";
import { loadListingInventory } from "./listing_inventory";
import { recentThreadMessages } from "./thread_messages";
import { requiredMountAdapters, renterProvidedAdapters } from "./required_mount_adapter";

/** Shared Native physical setup planning for quotes and atomic acceptance. */
export async function additionMountRequirements(ctx: QueryCtx, args: { thread_id: string; account_slug: string; product_id?: number; quantity?: number; items?: Array<{product_id:number;qty:number}> }) {
    if (!args.thread_id.startsWith("__probe__")) throw new Error("Mount addition planning is Lab-only pending written consent.");
    const order = await getLabOrder(ctx, args.thread_id);
    if (!order || order.account_slug !== args.account_slug) throw new Error("Missing matching Lab booking.");
    const inventory = await ctx.db.query("items").collect();
    const selections = args.items ?? (args.product_id != null && args.quantity != null ? [{ product_id: args.product_id, qty: args.quantity }] : []);
    if (!selections.length || selections.length > 8 || selections.some(item => !Number.isInteger(item.product_id) || item.product_id < 1 || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20))
      return { status: "unknown" as const, items: [], reason: "Selected listing identities or quantities are invalid." };
    const added: Array<{ item_id: string; quantity: number }> = [];
    for (const item of selections) {
      const selected = await loadListingInventory(ctx, args.account_slug, item.product_id, item.qty);
      if (!selected.complete || selected.owned !== true) return { status: "unknown" as const, items: [], reason: "Selected listing mapping is unverified." };
      added.push(...selected.components.map(c => ({ item_id: c.item_id, quantity: c.requested_units })));
    }
    const existing: Array<{ item_id: string; quantity: number }> = [];
    for (const line of order.items) {
      if (line.product_id == null) return { status: "unknown" as const, items: [], reason: "Existing basket mapping is unverified." };
      const contents = await loadListingInventory(ctx, args.account_slug, line.product_id, line.qty);
      if (!contents.complete || contents.owned !== true) return { status: "unknown" as const, items: [], reason: "Existing basket mapping is unverified." };
      existing.push(...contents.components.map(c => ({ item_id: c.item_id, quantity: c.requested_units })));
    }
    const items = inventory.filter(i => i.status === "active" && !i.is_marketing_only && i.qty > 0)
      .map(i => ({ id: String(i._id), name: i.name_canonical, kind: i.kind, mount: i.lens_mount }));
    const recent = await recentThreadMessages(ctx, args.thread_id, 60);
    const provided = recent.filter(message => message.sender !== "owner")
      .reduce((supplied, message) => renterProvidedAdapters(message.body_text, items, supplied), [] as Array<{ item_id: string; quantity: number }>);
    return { ...requiredMountAdapters(items, existing, added, provided), renter_supplied: provided.map(unit => ({ name: items.find(item => item.id === unit.item_id)!.name, quantity: unit.quantity })),
      guidance: "Renter-supplied adapters are their responsibility and are not owner stock or paid additions. Quoting never edits the booking." };
}
