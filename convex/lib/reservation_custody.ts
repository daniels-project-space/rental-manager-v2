import type { Doc } from "../_generated/dataModel";

export type CustodyRow = Pick<Doc<"reservations">,
  "_id" | "account_slug" | "hygglo_order_id" | "renter_id" | "renter_name" |
  "start_date" | "end_date" | "stock_custody_group_id" | "stock_custody_provenance">;

export function custodyRenterKey(row: Pick<CustodyRow,"renter_id" | "renter_name">) {
  if (row.renter_id) return `id:${row.renter_id}`;
  const name = row.renter_name?.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();
  return name && !["unknown","unknown renter","?","—"].includes(name) ? `name:${name}` : undefined;
}

export function custodyUnitsKey(units: Map<string,number>) {
  if (!units.size || [...units].some(([id,qty]) => !id || !Number.isSafeInteger(qty) || qty < 1)) return undefined;
  return JSON.stringify([...units].sort(([a],[b]) => a.localeCompare(b)));
}

/** A saved owner decision is valid only for the exact source booking and kit.
 * Mere name/basket matches never establish a physical allocation. */
export function confirmedCustodyGroup(row: CustodyRow, units: Map<string,number>) {
  const proof = row.stock_custody_provenance;
  if (row.account_slug === "dbcinema_web" || !row.stock_custody_group_id || !proof ||
      proof.source !== "owner_confirmation" || proof.account_slug !== row.account_slug ||
      proof.order_id !== row.hygglo_order_id || proof.renter_key !== custodyRenterKey(row) ||
      proof.units_key !== custodyUnitsKey(units) || proof.start_date !== row.start_date ||
      proof.end_date !== row.end_date || !Number.isFinite(proof.confirmed_at) || proof.confirmed_at <= 0 ||
      !proof.confirmed_by || proof.note.trim().length < 10) return undefined;
  return JSON.stringify(["owner-custody",row.account_slug,row.stock_custody_group_id,proof.renter_key]);
}

export function custodySourceBasis(row: CustodyRow, units: Map<string,number>) {
  return JSON.stringify([row._id,row.account_slug,row.hygglo_order_id,custodyRenterKey(row),
    row.start_date,row.end_date,custodyUnitsKey(units)]);
}
export function custodyBasis(row: CustodyRow, units: Map<string,number>) {
  return JSON.stringify([custodySourceBasis(row,units),row.stock_custody_group_id ?? null,row.stock_custody_provenance ?? null]);
}
