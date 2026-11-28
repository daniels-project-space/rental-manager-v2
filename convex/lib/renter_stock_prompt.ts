/** Render a stock receipt without turning a confirmed minimum into an exact
 * inventory count. Its dated verdict applies only to the checked quantity. */
export function componentStockContext(component: {
 item_name:string; available:boolean|null; requested_units:number; free_units:number|null;
 quantity_basis?:{basis?:string};
 renter_safe_availability_note?:string;
},start:string,end:string) {
 const verdict=component.available === true ? "AVAILABLE" : component.available === false ? "NOT AVAILABLE" : "UNKNOWN";
 const count=component.free_units == null ? "free count unknown"
  : component.quantity_basis?.basis === "owner_lower_bound" ? `at least ${component.free_units} units known free; exact total unknown`
  : `${component.free_units} units free`;
 const datedReason=component.available===false&&component.renter_safe_availability_note
  ? ` Verified date-specific reason: ${component.renter_safe_availability_note} This explains only this stock result; do not use it to explain a different pickup location.`
  : "";
 return `  COMPONENT AVAILABILITY (${component.item_name}): ${verdict}; requested ${component.requested_units}, ${count} for ${start} to ${end}. This verdict applies only to the checked quantity.${datedReason}${component.quantity_basis?.basis === "owner_lower_bound" ? " Do not infer a shortage above the confirmed minimum; check the requested amount, and if still unknown say you need to confirm." : ""}\n`;
}
