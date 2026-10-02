import type { RenterScope } from "./renter-tool-scope";

/** A standalone price is not evidence for a complete amended basket. */
export async function withBookingAdditionPreview(
  pricing: unknown,
  scope: RenterScope | undefined,
  preview: (args: Record<string, unknown>) => Promise<unknown>,
  lookupBase?: (args: Record<string, unknown>) => Promise<unknown>,
) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return pricing;
  const result = pricing as Record<string, unknown>;
  if (!scope?.threadId.startsWith("__probe__") || result.found !== true ||
      result.account_slug !== scope.accountSlug || !["hygglo_tier", "hygglo_listing"].includes(String(result.source)) ||
      !(typeof result.matched_canonical === "string" && result.matched_canonical.trim() || typeof result.matched_listing === "string" && result.matched_listing.trim()) ||
      typeof result.product_id !== "number" || !Number.isInteger(result.quantity) || Number(result.quantity) < 1) return pricing;
  let proposal: unknown;
  try {
    proposal = await preview({thread_id:scope.threadId,request_message_id:scope.requestMessageId ?? "",
      action:"add_item",item_name:result.matched_canonical ?? result.matched_listing,product_id:result.product_id,qty:result.quantity,preview_only:true});
    if (proposal && typeof proposal === "object" && (proposal as Record<string, unknown>).ok === true) {
      const addition = (proposal as Record<string, unknown>).addition_quote as Record<string, unknown> | undefined;
      const lines = addition?.lines;
      if (!Array.isArray(lines) || lines.length !== 1 || lines[0]?.product_id !== result.product_id || lines[0]?.qty !== result.quantity)
        proposal = {ok:false,error_code:"offering_requires_exact_quote",
          error:"The selected listing differs from the base-item addition. Do not substitute a body-only proposal for this listing; its exact basket requires a separate verified quote. No changes were made."};
    }
  } catch {
    proposal = {ok:false,error_code:"proposal_quote_unavailable",
      error:"The combined booking quote could not be verified. No changes were made. Do not offer a combined total or confirm the proposed basket."};
  }
  const response: Record<string, unknown> = {...result,booking_addition_preview:proposal};
  if (lookupBase && proposal && typeof proposal === "object" && (proposal as Record<string, unknown>).ok === false && Array.isArray(result.component_base_offerings)) {
    const options = result.component_base_offerings.filter((raw): raw is Record<string, unknown> =>
      !!raw && typeof raw === "object" && typeof raw.listing_name === "string" &&
      typeof raw.product_id === "number" && Number.isInteger(raw.product_id) && raw.product_id > 0 && raw.product_id !== result.product_id).slice(0,4);
    const quotes = await Promise.allSettled(options.map(async option => {
      const base = await lookupBase({item_name:option.listing_name,product_id:option.product_id,
        account_slug:scope.accountSlug,days:result.days,quantity:result.quantity});
      if (!base || typeof base !== "object" || (base as Record<string, unknown>).product_id !== option.product_id) return null;
      return await withBookingAdditionPreview(base,scope,preview);
    }));
    response.component_base_offering_quotes = quotes.flatMap(q => q.status === "fulfilled" && q.value ? [q.value] : []);
    response.component_quote_guidance = "These are separately priced component offerings, with different contents from the selected kit. Offer only an option whose booking_addition_preview.ok is true, using that option's price and exact contents. Never reuse the refused kit price for a body-only option. No booking changes were made.";
  }
  return response;
}
