import type { RenterScope } from "./renter-tool-scope";

async function attachVerifiedListingNames(
  proposal: unknown,
  scope: RenterScope,
  days: unknown,
  lookup: (args: Record<string, unknown>) => Promise<unknown>,
) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
  const result = proposal as Record<string, unknown>;
  const addition = result.addition_quote && typeof result.addition_quote === "object"
    ? result.addition_quote as Record<string, unknown> : null;
  const additionLines = Array.isArray(addition?.lines) ? addition.lines as Array<Record<string, unknown>> : [];
  if (result.ok !== true || !addition || !additionLines.length) return proposal;

  const identities = await Promise.all(additionLines.map(async line => {
    if (typeof line.product_id !== "number" || typeof line.name !== "string" ||
        typeof line.qty !== "number" || !Number.isInteger(line.qty) || line.qty < 1) return null;
    const raw = await lookup({ item_name: line.name, product_id: line.product_id, account_slug: scope.accountSlug, days, quantity: line.qty });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const price = raw as Record<string, unknown>;
    if (price.found !== true || price.account_slug !== scope.accountSlug || price.product_id !== line.product_id ||
        price.quantity !== line.qty || !["hygglo_tier", "hygglo_listing"].includes(String(price.source)) ||
        price.matched_canonical !== line.name) return null;
    const names = [price.display_name, price.matched_canonical, price.matched_listing,
      ...(Array.isArray(price.verified_price_names) ? price.verified_price_names : [])]
      .filter((name): name is string => typeof name === "string" && !!name.trim());
    return { product_id: line.product_id, names: [...new Set(names)] };
  }));
  const verified = identities.filter((identity): identity is { product_id: number; names: string[] } => !!identity?.names.length);
  if (!verified.length) return proposal;
  const namesByProduct = new Map(verified.map(identity => [identity.product_id, identity.names]));
  const withNames = (lines: unknown) => Array.isArray(lines) ? lines.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const line = raw as Record<string, unknown>, names = typeof line.product_id === "number" ? namesByProduct.get(line.product_id) : undefined;
    return names ? { ...line, verified_price_names: names } : line;
  }) : lines;
  const quote = result.quote && typeof result.quote === "object" ? result.quote as Record<string, unknown> : null;
  return {
    ...result,
    addition_quote: { ...addition, lines: withNames(addition.lines) },
    ...(quote ? { quote: { ...quote, lines: withNames(quote.lines) } } : {}),
  };
}

export async function completeMountBasket(
  scope: RenterScope, selections: Array<{ product_id: number; qty: number }>, days: unknown,
  requirements: (args: Record<string, unknown>) => Promise<unknown>,
  lookup: (args: Record<string, unknown>) => Promise<unknown>,
  quote: (args: Record<string, unknown>) => Promise<unknown>,
) {
  const plan = await requirements({ thread_id: scope.threadId, account_slug: scope.accountSlug, items: selections }) as { status?: string; reason?: string; items?: Array<{ name: string; quantity: number }>; renter_supplied?: Array<{ name: string; quantity: number }>; mount_evidence?: Array<Record<string, unknown>> };
  if (!plan || !["required", "none", "unknown"].includes(String(plan.status))) throw new Error("Unverified compatible setup");
  const required = plan.items ?? [];
  const selected = selections.map(item => ({ ...item }));
  const accessoryPrices: Record<string, unknown>[] = [];
  // Compatibility is a separate fact from price and dated stock. Keep those
  // independently verified facts useful to the renter, while marking this as
  // a provisional price-only proposal. The write path rechecks compatibility
  // and continues to reject unknown setups.
  if (plan.status === "unknown") {
    const rawProposal = await quote({ thread_id: scope.threadId, items: selected });
    const proposal = await attachVerifiedListingNames(rawProposal, scope, days, lookup);
    if (!proposal || typeof proposal !== "object" || (proposal as Record<string, unknown>).ok !== true)
      return { proposal, selected, required, accessoryPrices, renterSupplied: plan.renter_supplied ?? [], mountEvidence: plan.mount_evidence ?? [], setupStatus: "unverified" as const, setupReason: plan.reason };
    return {
      proposal: {
        ...(proposal as Record<string, unknown>),
        setup_status: "compatibility_unverified",
        setup_reason: plan.reason ?? "The exact equipment compatibility has not been verified.",
        price_and_stock_verified: true,
        action_eligible: false,
      },
      selected,
      required,
      accessoryPrices,
      renterSupplied: plan.renter_supplied ?? [],
      mountEvidence: plan.mount_evidence ?? [],
      setupStatus: "compatibility_unverified" as const,
      setupReason: plan.reason,
    };
  }
  for (const item of required) {
    const price = await lookup({ item_name: item.name, account_slug: scope.accountSlug, days, quantity: item.quantity }) as Record<string, unknown> | null;
    if (!price || price.found !== true || price.account_slug !== scope.accountSlug || price.matched_canonical !== item.name || !["hygglo_tier", "hygglo_listing"].includes(String(price.source)) || !Number.isInteger(price.product_id) || price.quantity !== item.quantity)
      return { proposal: { ok: false, error_code: "required_adapter_quote_unavailable", error: "The required adapter price is unverified; do not offer a complete setup quote." }, selected, required, accessoryPrices, renterSupplied: plan.renter_supplied ?? [], mountEvidence: plan.mount_evidence ?? [], setupStatus: "unverified" as const, setupReason: "A required adapter price is unverified." };
    accessoryPrices.push(price);
    const existing = selected.find(line => line.product_id === price.product_id);
    if (existing) existing.qty += item.quantity;
    else selected.push({ product_id: price.product_id as number, qty: item.quantity });
  }
  const rawProposal = await quote({ thread_id: scope.threadId, items: selected });
  const proposal = await attachVerifiedListingNames(rawProposal, scope, days, lookup);
  return { proposal, selected, required, accessoryPrices, renterSupplied: plan.renter_supplied ?? [], mountEvidence: plan.mount_evidence ?? [], setupStatus: required.length ? "adapter_required" as const : "verified" as const };
}

/** A standalone price is not evidence for a complete amended basket. */
export async function withBookingAdditionPreview(
  pricing: unknown,
  scope: RenterScope | undefined,
  preview: (args: Record<string, unknown>) => Promise<unknown>,
  lookupBase?: (args: Record<string, unknown>) => Promise<unknown>,
  mountRequirements?: (args: Record<string, unknown>) => Promise<unknown>,
  previewBasket?: (args: Record<string, unknown>) => Promise<unknown>,
) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return pricing;
  const result = pricing as Record<string, unknown>;
  if (!scope?.threadId.startsWith("__probe__") || result.found !== true ||
      result.account_slug !== scope.accountSlug || !["hygglo_tier", "hygglo_listing"].includes(String(result.source)) ||
      !(typeof result.matched_canonical === "string" && result.matched_canonical.trim() || typeof result.matched_listing === "string" && result.matched_listing.trim()) ||
      typeof result.product_id !== "number" || !Number.isInteger(result.quantity) || Number(result.quantity) < 1) return pricing;
  let proposal: unknown;
  let required: Array<{ name: string; quantity: number }> = [];
  let selected: Array<{ product_id: number; qty: number }> = [{ product_id: result.product_id as number, qty: result.quantity as number }];
  const accessoryPrices: Record<string, unknown>[] = [];
  let renterSupplied: Array<{ name: string; quantity: number }> = [];
  let mountEvidence: Array<Record<string, unknown>> = [];
  let responseSetupStatus: string | undefined;
  let responseSetupGuidance: string | undefined;
  try {
    if (mountRequirements && previewBasket && lookupBase) {
      const complete = await completeMountBasket(scope, selected, result.days, mountRequirements, lookupBase, previewBasket);
      required = complete.required; selected = complete.selected; accessoryPrices.push(...complete.accessoryPrices); proposal = complete.proposal; renterSupplied = complete.renterSupplied; mountEvidence = complete.mountEvidence;
      if (complete.setupStatus === "compatibility_unverified") {
        responseSetupGuidance = "The exact item price and dated shared-stock check are verified, but physical compatibility is not. You may state the checked addition price and proposed total as provisional only if relevant to the renter's question. Clearly say the setup fit still needs verification; do not call it compatible, ready, confirmed, or added, and do not ask the renter to accept or mutate this setup yet.";
        responseSetupStatus = complete.setupStatus;
      }
    }
    else proposal = previewBasket
      ? await previewBasket({ thread_id: scope.threadId, items: selected })
      : await preview({thread_id:scope.threadId,request_message_id:scope.requestMessageId ?? "",
      action:"add_item",item_name:result.matched_canonical ?? result.matched_listing,product_id:result.product_id,qty:result.quantity,preview_only:true});
    if (proposal && typeof proposal === "object" && (proposal as Record<string, unknown>).ok === true) {
      const addition = (proposal as Record<string, unknown>).addition_quote as Record<string, unknown> | undefined;
      const lines = addition?.lines;
      if (!Array.isArray(lines) || lines.length !== selected.length || !selected.every(item => lines.some(line => line.product_id === item.product_id && line.qty === item.qty)))
        proposal = {ok:false,error_code:"offering_requires_exact_quote",
          error:"The selected listing differs from the base-item addition. Do not substitute a body-only proposal for this listing; its exact basket requires a separate verified quote. No changes were made."};
    }
  } catch {
    proposal = {ok:false,error_code:"proposal_quote_unavailable",
      error:"The combined booking quote could not be verified. No changes were made. Do not offer a combined total or confirm the proposed basket."};
  }
  const response: Record<string, unknown> = {...result,booking_addition_preview:proposal,
    ...(mountEvidence.length ? { setup_mount_evidence: mountEvidence } : {}),
    ...(responseSetupStatus ? { setup_status: responseSetupStatus, setup_quote_guidance: responseSetupGuidance } : {}),
    ...(renterSupplied.length ? { renter_supplied_adapters: renterSupplied, renter_supplied_guidance: "The renter explicitly supplies these matching adapters; they are not owner stock or paid additions. Make that responsibility clear in the quote." } : {}),
    ...(required.length ? { required_accessory_names: required.map(item => item.name), required_accessory_quotes: accessoryPrices,
      setup_quote_guidance: "This compatible setup requires the listed adapters. Quote the complete additional_cost_gbp or give every component price, including required adapters. The original item price is only one component. The proposal is read-only; do not claim it was added. Do not offer the setup if its joint basket check fails." } : {})};
  if (lookupBase && proposal && typeof proposal === "object" && (proposal as Record<string, unknown>).ok === false && Array.isArray(result.component_base_offerings)) {
    const options = result.component_base_offerings.filter((raw): raw is Record<string, unknown> =>
      !!raw && typeof raw === "object" && typeof raw.listing_name === "string" &&
      typeof raw.product_id === "number" && Number.isInteger(raw.product_id) && raw.product_id > 0 && raw.product_id !== result.product_id).slice(0,4);
    const quotes = await Promise.allSettled(options.map(async option => {
      const base = await lookupBase({item_name:option.listing_name,product_id:option.product_id,
        account_slug:scope.accountSlug,days:result.days,quantity:result.quantity});
      if (!base || typeof base !== "object" || (base as Record<string, unknown>).product_id !== option.product_id) return null;
      return await withBookingAdditionPreview(base,scope,preview,lookupBase,mountRequirements,previewBasket);
    }));
    response.component_base_offering_quotes = quotes.flatMap(q => q.status === "fulfilled" && q.value ? [q.value] : []);
    response.component_quote_guidance = "These are separately priced component offerings, with different contents from the selected kit. Offer only an option whose booking_addition_preview.ok is true, using that option's price and exact contents. Never reuse the refused kit price for a body-only option. No booking changes were made.";
  }
  return response;
}
