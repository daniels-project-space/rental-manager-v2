import { ownerEnforcementRequired } from "./owner_authorization";
/** Website case identity/evidence are source-owned; projected claims and payouts remain operator-owned. */
export type WebsiteCase = {
  id: string; itemKey: string; title: string; details: string; status: "open" | "closed";
  openedAt: number; closedAt: number | null; resolution: string | null;
  customerAccountId: string | null; rmv2ItemId: string | null;
};
export function validateWebsiteCases(value: unknown): WebsiteCase[] {
  if (!Array.isArray(value) || value.length > 500) throw Error("Invalid website damage cases");
  const ids = new Set<string>();
  for (const c of value) {
    if (!c || ![c.id, c.itemKey, c.title, c.details].every(x => typeof x === "string" && x.trim().length > 0) ||
        !["open", "closed"].includes(c.status) || !Number.isSafeInteger(c.openedAt) || c.openedAt < 0 ||
        (c.closedAt !== null && (!Number.isSafeInteger(c.closedAt) || c.closedAt < c.openedAt)) ||
        ![c.resolution, c.customerAccountId, c.rmv2ItemId].every(x => x === null || typeof x === "string") ||
        (c.status === "closed" && (c.closedAt === null || !c.resolution?.trim())) || ids.has(c.id)) throw Error("Invalid website damage cases");
    ids.add(c.id);
  }
  return value;
}
export async function syncWebsiteCases(ctx: any, booking: any, reservationId: any, itemById: Map<string, any>) {
  if (booking.damageCases === undefined) return;
  const cases = validateWebsiteCases(booking.damageCases);
  if (cases.length && !ownerEnforcementRequired(process.env.OWNER_AUTH_REQUIRED)) throw Error("Website damage-case import requires enforced owner authentication");
  for (const c of cases) {
    const old = await ctx.db.query("insurance_claims").withIndex("by_site_case", (q: any) => q.eq("site_case_id", c.id)).first();
    if (old && (old.account_slug !== "dbcinema_web" || old.site_booking_id !== booking.id)) throw Error("Website case binding mismatch");
    if (old && (old.site_case_revision ?? 0) > (booking.revision ?? 0)) continue;
    // Source closures are irreversible here. A delayed open snapshot cannot reopen a resolved hold.
    if (old?.site_case_status === "closed" && c.status === "open") continue;
    const fields = {
      site_case_id: c.id, site_booking_id: booking.id, site_item_key: c.itemKey,
      site_customer_account_id: c.customerAccountId ?? undefined,
      site_case_status: c.status, site_case_resolution: c.resolution ?? undefined,
      site_case_closed_at: c.closedAt ?? undefined, site_case_revision: booking.revision ?? 0,
      reservation_id: reservationId, renter_name: booking.customerName ?? undefined,
    };
    if (old) {
      const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => old[k] !== v));
      if (Object.keys(patch).length) await ctx.db.patch(old._id, patch);
    } else {
      const item = c.rmv2ItemId ? itemById.get(c.rmv2ItemId) : undefined;
      await ctx.db.insert("insurance_claims", {
        ...fields, account_slug: "dbcinema_web", opened_from: "website_return",
        item_id: item?._id, repair_item_ids: item ? [item._id] : undefined, item_name_canonical: c.title, description: c.details,
        amount_gbp: 0, claim_date: new Date(c.openedAt).toISOString().slice(0, 10),
        status: "open", stage: "case_opened", created_at: c.openedAt,
      });
    }
  }
}
export type WebsiteCaseRow = {
  site_case_id?: string; site_booking_id?: string; site_customer_account_id?: string;
  site_case_status?: "open" | "closed"; site_case_resolution?: string; site_case_closed_at?: number;
};
export function websiteCaseView(row: WebsiteCaseRow) {
  return row.site_case_id ? { websiteCase: {
    id: row.site_case_id, bookingId: row.site_booking_id ?? "",
    customerAccountId: row.site_customer_account_id ?? null, status: row.site_case_status ?? "open",
    resolution: row.site_case_resolution ?? null, closedAt: row.site_case_closed_at ?? null,
  } } : {};
}
