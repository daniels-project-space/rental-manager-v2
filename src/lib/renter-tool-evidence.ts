import { renterItemNames, reviewedLensNames } from "../../convex/lib/renter_item_names";
import { explicitListingIncludedContents, type KitEvidence } from "../../convex/lib/kit_claims";
import { dateStockQuoteEvidence } from "./renter-date-stock-evidence";
/** Independent receipts from tool RESULTS, never the model's arguments or prose. */
export type ToolReceipt = { tool: string; call_id: string; result: Record<string, unknown> };
export type DeliveryCapabilityEvidence = {
  status: "pickup_only";
  account_slug: string;
  thread_id: string;
};

/** A persisted action receipt can make a failed generation's retry truthful,
 * but only when the order read is tied to this exact current renter message. */
export function currentTurnLabOrderReplay(
  receipts: ToolReceipt[],
  expected: { threadId: string; accountSlug: string; requestMessageId?: string },
): Record<string, unknown> | undefined {
  if (!expected.threadId.startsWith("__probe__") || !expected.requestMessageId) return undefined;
  const receipt = [...receipts].reverse().find(item => item.tool === "get_order_edit_state");
  if (!receipt) return undefined;
  const result = receipt.result;
  const proof = result.same_turn_replay;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return undefined;
  const action = proof as Record<string, unknown>;
  if (action.source !== "native_lab_amendment" || action.action !== "restore_referral_basket" ||
    action.thread_id !== expected.threadId || action.account_slug !== expected.accountSlug ||
    action.request_message_id !== expected.requestMessageId || result.account_slug !== expected.accountSlug ||
    result.start_date !== action.start_date || result.end_date !== action.end_date ||
    !Array.isArray(action.items) || !Array.isArray(result.lines) || !result.lines.length ||
    !Number.isInteger(result.days) || (result.days as number) < 1 ||
    typeof result.total_gbp !== "number" || !Number.isFinite(result.total_gbp) || result.total_gbp <= 0) return undefined;
  const expectedItems = action.items.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const line = raw as Record<string, unknown>;
    if (!Number.isInteger(line.product_id) || (line.product_id as number) < 1 ||
      !Number.isInteger(line.qty) || (line.qty as number) < 1) return null;
    return { product_id: line.product_id as number, qty: line.qty as number };
  });
  if (expectedItems.some(line => line === null)) return undefined;
  const actualItems = result.lines.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const line = raw as Record<string, unknown>;
    if (!Number.isInteger(line.product_id) || (line.product_id as number) < 1 ||
      !Number.isInteger(line.qty) || (line.qty as number) < 1 || typeof line.name !== "string" || !line.name.trim()) return null;
    return { product_id: line.product_id as number, qty: line.qty as number };
  });
  if (actualItems.some(line => line === null)) return undefined;
  const canonical = (items: Array<{ product_id: number; qty: number }>) => JSON.stringify(items.sort((a, b) => a.product_id - b.product_id));
  if (canonical(actualItems as Array<{ product_id: number; qty: number }>) !== canonical(expectedItems as Array<{ product_id: number; qty: number }>)) return undefined;
  return result;
}

/** Only a scoped check_location result can prove that this account is pickup-only.
 * A model statement, a failed postcode lookup, or another account's receipt is not proof. */
export function pickupOnlyDeliveryEvidence(
  receipts: ToolReceipt[],
  accountSlug: string,
  threadId: string,
): DeliveryCapabilityEvidence | undefined {
  let latestScopedResult: Record<string, unknown> | undefined;
  for (const receipt of receipts) {
    const result = receipt.result;
    if (receipt.tool !== "check_location" || result.account_slug !== accountSlug || result.thread_id !== threadId) continue;
    latestScopedResult = result;
  }
  if (latestScopedResult?.ok !== false || latestScopedResult.delivery_status !== "pickup_only") return undefined;
  return { status: "pickup_only", account_slug: accountSlug, thread_id: threadId };
}

const VERIFIED_KIT_SOURCES=new Set([
  "physical_mapping_and_inventory",
  "physical_mapping_and_owner_confirmed_listing",
  "owner_confirmed_listing",
  "inventory_record",
]);

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
    if (["quote_booking_addition", "quote_booking_replacement"].includes(r.tool) && r.result.ok === true &&
      r.result.source === "native_lab_proposal" && Array.isArray(r.result.added_kit_evidence)) {
      for (const raw of r.result.added_kit_evidence) {
        if (!raw || typeof raw !== "object") continue;
        const kit = raw as Record<string, unknown>;
        if (!VERIFIED_KIT_SOURCES.has(String(kit.source)) || typeof kit.name !== "string" || !kit.name.trim() ||
          !Array.isArray(kit.contents) || !kit.contents.length || !kit.contents.every(c => typeof c === "string" && c.trim())) continue;
        evidence.push({names:renterItemNames(kit.name),contents:kit.contents as string[]});
      }
    }
    if (r.tool !== "find_owned_alternatives" || !Array.isArray(r.result.alternatives)) continue;
    for (const raw of r.result.alternatives) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (!VERIFIED_KIT_SOURCES.has(String(a.kit_source)) || typeof a.name !== "string" || !Array.isArray(a.kit_contents) || !a.kit_contents.length || !a.kit_contents.every(c => typeof c === "string" && c.trim())) continue;
      const model = a.spec_verification && typeof a.spec_verification === "object" ? (a.spec_verification as Record<string, unknown>).model : null;
      evidence.push({ names: [...new Set([a.name, a.listing_name, model].filter((n): n is string => typeof n === "string" && !!n).flatMap(renterItemNames))], contents: a.kit_contents as string[], ...(typeof a.kind === "string" && a.kind ? { kind: a.kind } : {}) });
    }
  }
  return evidence;
}

/** Attach accessory evidence only from a successful, account-scoped listing
 * lookup for a product already present in the active rental context. Marketing
 * prose outside an explicit included-contents section never qualifies. */
export function mergeListingDescriptionKitEvidence(
  existing: KitEvidence[],
  receipts: ToolReceipt[],
  accountSlug: string,
  activeListings: Array<{ product_id?: number | null; name?: string | null; listing_name?: string | null; inventory_name?: string | null; kind?: string | null }>,
): KitEvidence[] {
  if (!accountSlug || !Array.isArray(activeListings)) return existing;
  const merged = existing.map(e => ({ ...e, names: [...e.names], contents: [...e.contents] }));
  const allowed = new Map(activeListings.filter(x => typeof x.product_id === "number")
    .map(x => [x.product_id!, x] as const));
  for (const receipt of receipts) {
    if (receipt.tool !== "get_listing_context" || !Array.isArray(receipt.result.items)) continue;
    for (const raw of receipt.result.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const productId = typeof row.product_id === "number" ? row.product_id : null;
      if (productId === null) continue;
      const active = allowed.get(productId);
      if (!active || row.account_slug !== accountSlug || row.listing_description_source !== "online_listings" || typeof row.listing_description !== "string") continue;
      const listingContents = explicitListingIncludedContents(row.listing_description);
      if (!listingContents.length) continue;
      const names = [...new Set([active.name, active.listing_name, active.inventory_name]
        .filter((x): x is string => typeof x === "string" && !!x.trim()).flatMap(renterItemNames))];
      if (!names.length) continue;
      const evidence = {
        names,
        contents: [] as string[],
        listing_contents: listingContents,
        listing_source: "online_listings" as const,
        listing_account_slug: accountSlug,
        listing_product_id: productId,
        ...(typeof row.listing_description_updated_at === "number" ? { listing_description_updated_at: row.listing_description_updated_at } : {}),
        ...(typeof active.kind === "string" && active.kind ? { kind: active.kind } : {}),
      };
      let at = merged.findIndex(e => e.account_slug === accountSlug && e.product_id === productId);
      // Physical kit receipts from get_listing_context are initially keyed by
      // renter-facing item name; the product/account identity is on the same
      // successful tool result. Join only when exactly one unscoped receipt
      // matches the exact active listing identity. This keeps seller-text
      // claims attached to the physical kit evidence without allowing a
      // same-name item from another account or an ambiguous bundle to lend
      // proof to it.
      if (at < 0) {
        const normalizedNames = new Set(names.map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
        const unscopedMatches = merged.flatMap((candidate, index) => {
          if (candidate.account_slug || candidate.product_id != null) return [];
          const matches = candidate.names.some(name =>
            normalizedNames.has(name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
          );
          return matches ? [index] : [];
        });
        if (unscopedMatches.length === 1) at = unscopedMatches[0];
      }
      if (at >= 0) {
        const current = merged[at];
        merged[at] = {
          ...current,
          account_slug: current.account_slug ?? accountSlug,
          product_id: current.product_id ?? productId,
          names: [...new Set([...current.names, ...evidence.names])],
          listing_contents: [...new Set([...(current.listing_contents ?? []), ...listingContents])],
          listing_source: "online_listings",
          listing_account_slug: accountSlug,
          listing_product_id: productId,
          ...(evidence.listing_description_updated_at !== undefined ? { listing_description_updated_at: evidence.listing_description_updated_at } : {}),
        };
      } else {
        merged.push(evidence);
      }
    }
  }
  return merged;
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
      const dateStockQuote=payload.toolName==="quote_booking_dates"
        ? dateStockQuoteEvidence({tool:"quote_booking_dates",call_id:String(payload.toolCallId??"unknown"),result},typeof result.thread_id==="string"?result.thread_id:undefined)
        : null;
      const dateBasket=dateStockQuote?{available:true as const,items:dateStockQuote.items.map(i=>({name:i.name,quantity:i.quantity}))}:undefined;
      // An atomic inquiry write carries the same Native basket receipt as a
      // read-only quote. Harvest it once through the shared quote/stock path.
      const inquiryReceipt=result.ok===true && result.action_performed===true && result.source==="native_lab_amendment" &&
        result.context_transition && typeof result.context_transition==="object" &&
        (result.context_transition as Record<string,unknown>).source==="native_lab_amendment" &&
        result.verified_inquiry_quote && typeof result.verified_inquiry_quote==="object"?result.verified_inquiry_quote:null;
      if(inquiryReceipt)visit({toolName:"check_basket_availability",toolCallId:`${String(payload.toolCallId??"unknown")}:accepted-inquiry-quote`,result:{
        ...inquiryReceipt,
        // A successful referral restore creates the destination friend's own
        // inquiry. Mark that scope on the derived Native receipt so the price
        // guard validates the exact restored basket, rather than the empty
        // basket that existed before the atomic restore.
        ...(payload.toolName==="restore_referral_basket"?{new_inquiry:true}:{}),
      }});
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
      // A verified duplicate-listing choice is a useful negative tool result:
      // it contains exact source-backed per-day options but deliberately has
      // no selected product or basket total. Keep this one typed receipt so
      // the price adapter can validate its Lab/account/date scope; generic
      // tool errors remain excluded.
      const verifiedListingChoice = payload.toolName === "quote_booking_addition" && result.ok === false &&
        result.selection_required === true && result.reason === "multiple_verified_listings" &&
        result.source === "verified_listing_choices" && typeof result.account_slug === "string" &&
        typeof result.thread_id === "string" && typeof result.matched_canonical === "string" &&
        Array.isArray(result.listing_options);
      if ((!result.error && result.ok !== false && result.found !== false) || verifiedListingChoice)
        receipts.push({ tool: payload.toolName, call_id: String(payload.toolCallId ?? "unknown"), result });
      // A typed account-scoped pickup-only decision is useful negative
      // capability evidence even though check_location reports ok:false. Do
      // not retain generic failures, invalid postcodes, or unscoped prose.
      if (payload.toolName === "check_location" && result.ok === false && result.delivery_status === "pickup_only" &&
          typeof result.account_slug === "string" && typeof result.thread_id === "string")
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
            receipts.push({ tool: "check_availability", call_id: `${String(payload.toolCallId ?? "unknown")}:amendment-stock:${String(r.item_id)}`, result: {...r,...(dateBasket?{basket:dateBasket}:{})} });
          }
        }
      }
      if (!result.error && result.ok !== false && result.found !== false && payload.toolName === "find_owned_alternatives") {
        const target = result.target_stock_receipt as Record<string, unknown> | null;
        if (result.target_identity_resolved === true && result.target_rentable === false && target &&
            target.source === "shared_inventory_confirmed_rentals" && target.available === false && target.owned === false &&
            String(target.item_id) === String(result.target_item_id) && target.item_name === result.target)
          receipts.push({tool:"check_availability",call_id:`${String(payload.toolCallId ?? "unknown")}:target-stock`,result:target});
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
