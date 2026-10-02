import type { RenterScope } from "./renter-tool-scope";

/** A standalone price is not evidence for a complete amended basket. */
export async function withBookingAdditionPreview(
  pricing: unknown,
  scope: RenterScope | undefined,
  preview: (args: Record<string, unknown>) => Promise<unknown>,
) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return pricing;
  const result = pricing as Record<string, unknown>;
  if (!scope?.threadId.startsWith("__probe__") || result.found !== true ||
      result.account_slug !== scope.accountSlug || !["hygglo_tier", "hygglo_listing"].includes(String(result.source)) ||
      typeof result.matched_canonical !== "string" || !result.matched_canonical.trim() ||
      typeof result.product_id !== "number" || !Number.isInteger(result.quantity) || Number(result.quantity) < 1) return pricing;
  let proposal: unknown;
  try {
    proposal = await preview({thread_id:scope.threadId,request_message_id:scope.requestMessageId ?? "",
      action:"add_item",item_name:result.matched_canonical,qty:result.quantity,preview_only:true});
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
  return {...result,booking_addition_preview:proposal};
}
