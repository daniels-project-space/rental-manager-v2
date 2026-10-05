import { renterItemNames, reviewedLensNames } from "../../convex/lib/renter_item_names";
/** Independent receipts from tool RESULTS, never the model's arguments or prose. */
export type ToolReceipt = { tool: string; call_id: string; result: Record<string, unknown> };

/** A Native basket has the same physical receipts whether Mastra or server
 * hydration invoked the tool. Never substitute its aggregate commercial name. */
export function availabilityComponentReceipts(receipt:ToolReceipt):ToolReceipt[] {
 const {tool,call_id,result}=receipt;
 if(result.error||result.ok===false||!["check_availability","check_basket_availability"].includes(tool)||!Array.isArray(result.components))return [];
 return result.components.flatMap(raw=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return [];
  const component=raw as Record<string,unknown>;
  return [{tool:"check_availability",call_id:`${call_id}:component:${String(component.item_id??component.item_name)}`,result:component}];
 });
}

/** Only server-returned recommendation contents can qualify an alternative's kit. */
export function recommendationKitEvidence(receipts: ToolReceipt[]) {
  const evidence: Array<{ names: string[]; contents: string[]; kind?: string }> = [];
  for (const r of receipts) {
    if (r.tool !== "find_owned_alternatives" || !Array.isArray(r.result.alternatives)) continue;
    for (const raw of r.result.alternatives) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (!["physical_mapping_and_inventory", "inventory_record"].includes(String(a.kit_source)) || typeof a.name !== "string" || !Array.isArray(a.kit_contents) || !a.kit_contents.length || !a.kit_contents.every(c => typeof c === "string" && c.trim())) continue;
      const model = a.spec_verification && typeof a.spec_verification === "object" ? (a.spec_verification as Record<string, unknown>).model : null;
      evidence.push({ names: [...new Set([a.name, a.listing_name, model].filter((n): n is string => typeof n === "string" && !!n).flatMap(renterItemNames))], contents: a.kit_contents as string[], ...(typeof a.kind === "string" && a.kind ? { kind: a.kind } : {}) });
    }
  }
  return evidence;
}

export function renterToolReceipts(steps: unknown): ToolReceipt[] {
  const receipts: ToolReceipt[] = [];
  const seen = new Set<unknown>();
  const handledOutputs = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as Record<string, unknown>;
    const payload = (value.payload ?? value) as Record<string, unknown>;
    const output = payload.result ?? payload.output;
    if (typeof payload.toolName === "string" && output && typeof output === "object" && !Array.isArray(output) && !handledOutputs.has(output)) {
      handledOutputs.add(output);
      const result = output as Record<string, unknown>;
      // An atomic inquiry write carries the same Native basket receipt as a
      // read-only quote. Harvest it once through the shared quote/stock path.
      const inquiryReceipt=result.ok===true && result.action_performed===true && result.source==="native_lab_amendment" &&
        result.context_transition && typeof result.context_transition==="object" &&
        (result.context_transition as Record<string,unknown>).source==="native_lab_amendment" &&
        result.verified_inquiry_quote && typeof result.verified_inquiry_quote==="object"?result.verified_inquiry_quote:null;
      if(inquiryReceipt)visit({toolName:"check_basket_availability",toolCallId:`${String(payload.toolCallId??"unknown")}:accepted-inquiry-quote`,result:inquiryReceipt});
      // The pricing adapter performs a real read-only Native proposal check.
      // Harvest its result through the same validation path as an explicit
      // quote tool, including negative shared-stock receipts from refusals.
      // Acceptance carries the exact Native preparation used in its transaction.
      // This is price evidence; the parent mutation's action flag proves the edit.
      if (payload.toolName === "modify_booking" && result.ok === true && result.action_performed === true &&
          result.source === "native_lab_amendment" && result.verified_quote && typeof result.verified_quote === "object" &&
          result.context_transition && typeof result.context_transition === "object" &&
          (result.context_transition as Record<string, unknown>).source === "native_lab_amendment")
        visit({toolName:(result.verified_quote as Record<string,unknown>).change_kind==="replacement"?"quote_booking_replacement":"quote_booking_addition",toolCallId:`${String(payload.toolCallId ?? "unknown")}:accepted-quote`,result:result.verified_quote});
      if(payload.toolName==="modify_booking" && result.ok===true && result.action_performed===true && result.verified_date_quote && typeof result.verified_date_quote==="object" && result.context_transition && typeof result.context_transition==="object" && (result.context_transition as Record<string,unknown>).source==="native_lab_amendment")
        visit({toolName:"quote_booking_dates",toolCallId:`${String(payload.toolCallId??"unknown")}:accepted-date-quote`,result:result.verified_date_quote});
      if (payload.toolName === "lookup_pricing" && result.found === true && result.booking_addition_preview && typeof result.booking_addition_preview === "object")
        visit({toolName:"quote_booking_addition",toolCallId:`${String(payload.toolCallId ?? "unknown")}:booking-preview`,result:result.booking_addition_preview});
      if (payload.toolName === "lookup_pricing" && result.found === true && Array.isArray(result.component_base_offering_quotes))
        result.component_base_offering_quotes.forEach((quote, i) => visit({toolName:"lookup_pricing",toolCallId:`${String(payload.toolCallId ?? "unknown")}:component-base:${i}`,result:quote}));
      if (payload.toolName === "lookup_pricing" && result.found === true && Array.isArray(result.required_accessory_quotes))
        result.required_accessory_quotes.forEach((quote, i) => visit({toolName:"lookup_pricing",toolCallId:`${String(payload.toolCallId ?? "unknown")}:required-accessory:${i}`,result:quote}));
      if (!result.error && result.ok !== false && result.found !== false)
        receipts.push({ tool: payload.toolName, call_id: String(payload.toolCallId ?? "unknown"), result });
      receipts.push(...availabilityComponentReceipts({tool:payload.toolName,call_id:String(payload.toolCallId??"unknown"),result}));
      if ((["modify_booking","quote_booking_addition","quote_booking_replacement","quote_booking_dates"].includes(payload.toolName)) && result.ok === true && result.stock_receipt && typeof result.stock_receipt === "object")
        receipts.push({ tool: "check_availability", call_id: `${String(payload.toolCallId ?? "unknown")}:mutation-stock`, result: result.stock_receipt as Record<string, unknown> });
      // A rejected amendment can still carry a genuine negative calendar
      // check. Retain that check, never turn the failed write into a success.
      if (!inquiryReceipt && Array.isArray(result.stock_receipts)) {
        for (const raw of result.stock_receipts) {
          if (raw && typeof raw === "object" && (raw as Record<string, unknown>).source === "shared_inventory_confirmed_rentals") {
            const r = raw as Record<string, unknown>;
            receipts.push({ tool: "check_availability", call_id: `${String(payload.toolCallId ?? "unknown")}:amendment-stock:${String(r.item_id)}`, result: r });
          }
        }
      }
      if (!result.error && result.ok !== false && result.found !== false && payload.toolName === "find_owned_alternatives") {
        const options = [...(Array.isArray(result.alternatives) ? result.alternatives : []), ...(Array.isArray(result.rejected_stock_options) ? result.rejected_stock_options : [])];
        for (const alternative of options) {
          const a = alternative as Record<string,unknown>;
          if (!Array.isArray(a.stock_receipts)) continue;
          for (const raw of a.stock_receipts) {
            if (raw && typeof raw === "object" && raw.source === "shared_inventory_confirmed_rentals")
              receipts.push({tool:"check_availability",call_id:`${String(payload.toolCallId ?? "unknown")}:${String(a.name)}:basket:${String(raw.item_id)}`,result:{...raw,
                ...(typeof a.name==="string" && raw.item_name===a.name && a.kind==="lens" ? {identity_names:reviewedLensNames({...a,name:a.name})} : {})}});
          }
        }
      }
      if (!result.error && result.ok !== false && result.found !== false && payload.toolName === "find_owned_alternatives" && Array.isArray(result.alternatives)) {
        for (const alternative of result.alternatives) {
          const a = alternative as Record<string, unknown>;
          const stock = a.availability as Record<string, unknown> | null;
          if (stock?.available === true && typeof a.name === "string")
            receipts.push({ tool: "check_availability", call_id: `${String(payload.toolCallId ?? "unknown")}:${a.name}`, result: { ...stock, item_name: a.name, owned: true, requested_units: stock.quantity, ...(typeof a.kind === "string" && a.kind.trim() ? {kind:a.kind} : {}),
              ...(a.kind==="lens" ? {identity_names:reviewedLensNames({...a,name:a.name})} : {}) } });
        }
      }
    }
    for (const [key, child] of Object.entries(value))
      if (!["args", "input", "result", "output"].includes(key)) visit(child);
  };
  visit(steps);
  return receipts;
}

export function stockReceipts(receipts: ToolReceipt[]) {
  const keys = new Set<string>();
  return receipts.filter((r) => r.tool === "check_availability" &&
    // Aggregate proposal/listing results describe the whole physical basket.
    // Their echoed or commercial name is not an independent stock receipt.
    // Harvested component receipts carry the exact Native item identities.
    !["current_booking","proposed_basket"].includes(String(r.result.stock_scope)) &&
    !(r.result.source === "complete_listing_components" && Array.isArray(r.result.components)) &&
    (typeof r.result.available === "boolean" || r.result.available === null) &&
    typeof r.result.item_name === "string" &&
    typeof r.result.start_date === "string" &&
    typeof r.result.end_date === "string" &&
    typeof r.result.requested_units === "number" && Number.isInteger(r.result.requested_units) &&
    typeof r.result.checked_at === "number" &&
    (typeof r.result.free_units === "number" || r.result.free_units === null))
    .filter((r) => { const key = `${r.call_id}|${r.result.item_name}|${r.result.start_date}|${r.result.end_date}|${r.result.requested_units}`; if (keys.has(key)) return false; keys.add(key); return true; });
}

export function availabilityEvidence(receipts: ToolReceipt[]) {
  return stockReceipts(receipts).filter((r) => typeof r.result.available === "boolean" && (r.result.available === false || r.result.owned === true));
}

export function successfulGrounding(receipts: ToolReceipt[]) {
  const stock = availabilityEvidence(receipts);
  return {
    availability: stock.some((r) => r.result.available === true),
    unavailability: stock.some((r) => r.result.available === false),
    price: receipts.some((r) => r.tool === "lookup_pricing" && r.result.found === true && typeof r.result.daily_rate_gbp === "number"),
    specs: receipts.some((r) => r.tool === "get_listing_context" && Array.isArray(r.result.items) && r.result.items.length > 0),
  };
}
