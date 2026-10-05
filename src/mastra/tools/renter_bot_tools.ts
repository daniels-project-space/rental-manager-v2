import { RECORDING_REQUIREMENT_RESOLUTIONS, canonicalRecordingResolution } from "../../../convex/lib/camera_requirements";
/**
 * Renter-bot Mastra tools (7) — thin wrappers over Convex queries.
 *
 * The agent calls these tools at runtime; the actual data fetches happen
 * inside Convex. This file is invoked from `src/mastra/agents/renter_bot.ts`
 * which registers the tools on the agent.
 *
 * Each tool defines:
 *   - id           — stable handle (the agent prompt references these names)
 *   - description  — used by the LLM to decide when to call
 *   - inputSchema  — Zod
 *   - outputSchema — Zod (helps the agent reason about the return type)
 *   - execute      — calls Convex via ConvexHttpClient
 *
 * Native reads plus guarded Lab booking mutations. Combined quote previews
 * never write an order. No real Hygglo write API is reachable from a tool.
 */
import "server-only";

import { recordRentalRequest,recordRecommendationRequirements } from "@/lib/renter-tool-scope";
import { nativeInquiryQuote, nativeBookingRecord } from "@/lib/renter-native-quote";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createRequestConvexClient } from "@/lib/convex-request-context";
import { getFunctionName } from "convex/server";
import { bindRenterToolArgs, currentRenterToolScope } from "@/lib/renter-tool-scope";
import { completeMountBasket, withBookingAdditionPreview } from "@/lib/renter-pricing-preview";
import { api } from "@/../convex/_generated/api";
// Convex typegen runs against a real deployment via `npx convex dev`.
// Until the new modules (renter_bot_tools, knowledge, renter_bot_drafts)
// are typed against the live deployment, we use the project-wide
// `anyApi` cast — same pattern hygglo_poll.ts uses for new namespaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

function convex(): ConvexHttpClient {
  const client = createRequestConvexClient();
  // A request can share its reader with hydration. Bind each invocation
  // without rewriting the shared client's methods or stacking wrappers.
  return new Proxy(client, {
    get(target, key) {
      if (key === "query" || key === "mutation" || key === "action") {
        const invoke = target[key].bind(target) as (fn: Parameters<typeof client.query>[0], args: Record<string, unknown>) => Promise<unknown>;
        return (fn: Parameters<typeof client.query>[0], args: Record<string, unknown> = {}) => invoke(fn, bindRenterToolArgs(getFunctionName(fn), args));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ── Tool 1: get_renter_context ────────────────────────────────

export const getRenterContextTool = createTool({
  id: "get_renter_context",
  description:
    "Fetch renter + conversation context for a thread. ALWAYS call FIRST. Returns account_slug (for voice), renter profile (incl. blacklist, DNA, lifetime spend, rating), conversation_stage, and the last 12 messages.",
  inputSchema: z.object({
    thread_id: z.string().describe("Hygglo thread id (= hygglo_order_id)"),
  }),
  outputSchema: z.object({
    thread_id: z.string(),
    account_slug: z.string(),
    hygglo_order_id: z.string(),
    renter: z.unknown().nullable(),
    renter_history:z.object({platform_completed_rentals:z.number().nullable(),recorded_rentals_with_us:z.number().nullable(),last_rental_with_us_at:z.number().nullable()}),
    conversation_stage: z.string(),
    rental_stage: z.unknown(),
    last_message_id: z.string().nullable(),
    owner_checks: z.array(z.object({
      kind:z.enum(["lens_recommendation","camera_recommendation","listing_mapping"]),product_id:z.number().nullable(),
      task_id:z.string(),status:z.enum(["pending","handled_by_owner"]),requirements:z.unknown(),lens_mount:z.string().nullable(),
      start_date:z.string().nullable(),end_date:z.string().nullable(),quantity:z.number(),candidate_names:z.array(z.string()),
      context_changed:z.boolean(),source_message_id:z.string(),specification_result_verified:z.literal(false),customer_input_required:z.literal(false),
    })),
    last_messages: z.array(
      z.object({
        sender: z.string(),
        sender_name: z.string(),
        body: z.string(),
        at: z.number(),
      }),
    ),
  }),
  execute: async ({ thread_id }) => {
    return await convex().query(anyApi.renter_bot_tools.get_renter_context, {
      thread_id,
    });
  },
});

// ── Tool 2: get_listing_context ───────────────────────────────

export const getListingContextTool = createTool({
  id: "get_listing_context",
  description:
    "Fetch the listing/items context for a thread. Returns items, dates, prices, recorded kit contents, equipment_usage, booking_record and owner_checks for unresolved selected kit mappings. For closed-rental history select booking_record.record_key in a booking_record reply part; its original recorded amount is distinct from a new enquiry quote and may be paid, quoted or unknown. equipment_usage separates supplied camera bodies from the renter's unknown chosen body; lens mount never identifies their camera. Those checks become persistent owner tasks when the draft or review is saved; no extra tool call or renter input is needed for an internal mapping gap. whats_included and kit_contents contain recorded inventory contents per listing, never advertising prose. kit_completeness is partial or unknown: an absent accessory is unverified, not excluded; mapping_complete refers only to stock mapping.",
  inputSchema: z.object({
    thread_id: z.string(),
  }),
  outputSchema: z.unknown(),
  execute: async ({ thread_id }) => {
    const result=await convex().query(anyApi.renter_bot_tools.get_listing_context, {thread_id});
    const scope=currentRenterToolScope();
    return {...result,booking_record:scope?nativeBookingRecord(result.booking_record,scope):null};
  },
});

// ── Tool 3: lookup_pricing ────────────────────────────────────

export const lookupPricingTool = createTool({
  id: "lookup_pricing",
  description:
    "If booking_addition_preview is returned, use its addition_quote/additional_cost_gbp for the extra and quote.total_gbp for the proposed COMPLETE booking total. Its dates and combined stock check belong to the current booking; the standalone price below can use a different requested duration. This is a read-only proposal, never an edit. If the preview fails, do not calculate a combined total or promise the added basket from standalone prices. component_base_offering_quotes can provide separate body/component alternatives: use only their own successful preview and price, explain their different contents, and never transfer the refused kit price to them. " +
    // The 'one retry, using did_you_mean' clause is the point. Measured, this
    // tool was called with progressively shortened invented names — "Blazar
    // Remus full frame 33mm t1.8 1.5x anamorphic", then "Blazar Remus 33mm",
    // then "Anamorphic Blazar Remus 33mm" — because a miss returned no way to
    // correct the name. Each retry is another agent step re-sending the whole
    // base prompt.
    "Look up undiscounted base prices and totals for an item. Distance-discount eligibility is unverified here; do not infer an approved reduction from this price result. For an option returned by find_owned_alternatives, pass its quote.product_id and exact listing_name to preserve that selected offering. Prefer that vetted base option for a general body request; another listing for the same body may have different prices or contents. Preserve an explicitly requested exact kit. Use the returned display_name or matched_canonical in renter replies. matched_listing is an internal lookup title, not proof of supplied SSD/card/lens contents or comparison models; never copy those title claims into a body quote. Call BEFORE quoting any price. Use this for any item NOT on the current request: an alternative, a second body, a different quantity, or anything the renter added. For items that ARE on the request, use get_listing_context daily_price_gbp + whats_included instead. Pass account_slug. Pass the item's FULL title exactly as you were given it — do not shorten or rephrase it. A found:false price result does not prove dated unavailability. Read its reason/message: an unverified mapping needs owner review, and a missing price needs price confirmation. Before a stock refusal, check the exact requested item/components and dates through check_availability. If did_you_mean contains the same item, call ONCE more with that exact title. Never retry with a reworded version of a name that already missed, and never quote a price for a did_you_mean entry you have not looked up.",
  inputSchema: z.object({
    item_name: z.string(),
    product_id: z.number().int().positive().optional().describe("Exact listing ID returned by Native recommendation quote.product_id, listing context or a prior pricing result. Pass it for a selected offering so another listing for the same body cannot replace its price. Never guess an ID."),
    // REQUIRED, because optional meant "forgotten".
    //
    // Measured: the agent's FIRST call routinely omitted it — lookup_pricing
    //({item_name:"Blazar Remus full frame 33mm t1.8 1.5x anamorphic"}) with no
    // account — and without it the Convex query skips the entire real-listing
    // block and falls through to the curated catalog, returning an ESTIMATED
    // price. The agent then noticed and called again WITH the account, so the
    // retry loop was not really about the name at all: it was one wasted step
    // per lookup, each re-sending the whole base prompt.
    //
    // The account is a property of the thread, not a judgement call, and it is
    // already in front of the model (ACCOUNT: <slug> in the prompt, and
    // get_renter_context). Requiring it removes the chance to forget.
    account_slug: z
      .string()
      .describe(
        "REQUIRED. The account_slug for this thread — it is given to you as ACCOUNT in the prompt, and by get_renter_context. Without it the price comes from a generic estimate instead of THIS account's real Hygglo listing.",
      ),
    days: z.number().int().positive().optional().describe("Rental duration in days. Default 1."),
    quantity: z.number().int().min(1).max(20).optional().describe("Number of units of this priced item. Default 1; the returned total already includes quantity." ),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    const client = convex();
    const pricing = await client.query(anyApi.renter_bot_tools.lookup_pricing, input);
    return await withBookingAdditionPreview(pricing, currentRenterToolScope(), args => client.mutation(anyApi.renter_bot_lab_order.applyChange, args), args => client.query(anyApi.renter_bot_tools.lookup_pricing, args),
      args => client.query(anyApi.renter_bot_tools.get_addition_mount_requirements, args), args => client.query(anyApi.renter_bot_lab_order.quoteAdditionBasket, args));
  },
});

// ── Tool 4: check_availability ────────────────────────────────

export const checkAvailabilityTool = createTool({
  id: "check_availability",
  description:
    "Check whether an item is available for a date range across active reservations. Call BEFORE confirming or refusing equipment availability. Check the exact requested gear before switching to alternatives. An explicit lens family with several focal lengths is expanded and checked jointly by Native in this call. Read its actual component receipts and verdict. A non-rentable member can prevent the whole set being supplied without implying every lens is missing. resolved_items alone are identities, not stock evidence. For a separate new hire use booking_use=separate, which keeps the existing rental reserved. For an open confirmed booking, specify additional or replacement: the full proposed basket is checked, including existing gear and shared kit components. Replacement requires an exact current replace_product_id and does not edit anything. A standalone check cannot bypass the confirmed basket; current-booking prefetch does not prove extras. available:null means unknown/ambiguous/invalid, NEVER available or unavailable. Honors shared stock, repairs, blackouts, vacation and return buffers. Marketing-only gear always returns available:false. For a kit/listing pass its product_id: checking one component does not prove the whole kit is available. The result includes each component receipt.",
  inputSchema: z.object({
    item_name: z.string(),
    booking_use: z.enum(["current","standalone","additional","replacement","separate"]).optional().describe("current checks existing booked gear (including a proposed new date span), additional retains it plus the extra, replacement removes a selected listing. current cannot bypass an explicit additional/replacement request."),
    replace_product_id: z.number().int().positive().optional(),
    replace_quantity: z.number().int().min(1).max(20).optional(),
    product_id: z.number().int().optional().describe("For a LISTING or KIT, use the exact product_id from get_listing_context; checks every component and quantity. Never invent an id."),
    quantity: z.number().int().min(1).max(20).optional().describe("Units the renter actually requests; default 1."),
    pickup_time: z.string().optional().describe("Agreed London pickup time HH:MM; omit when unknown."),
    return_time: z.string().optional().describe("Agreed London return time HH:MM; omit when unknown."),
    thread_id: z.string().optional().describe("Current conversation THREAD, to avoid the booking blocking its own existing units."),
    start_date: z.string().describe("ISO YYYY-MM-DD"),
    end_date: z.string().describe("ISO YYYY-MM-DD"),
    // Required for the same reason as lookup_pricing: optional meant forgotten,
    // and an availability answer that isn't scoped to this account is worse
    // than no answer. The slug is in the prompt as ACCOUNT.
    account_slug: z
      .string()
      .describe("REQUIRED. The account_slug for this thread — given to you as ACCOUNT in the prompt."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.check_availability, input);
  },
});

/** Joint proposals must share one physical stock allocation. */
export const checkBasketAvailabilityTool = createTool({
  id: "check_basket_availability",
  description: "Check ALL proposed items together in one shared-stock snapshot before saying both/all are available. Separate successful item checks do not prove they can go out together. Include each exact item/listing and quantity. For a confirmed booking choose additional to retain its gear, or replacement with the exact listing to remove. For a separate new hire in a thread with an existing rental, use booking_use=separate: Native checks only the new basket while keeping the existing reservation in stock. This does not confirm or change a booking. For a new inquiry, exact listing IDs return joint stock AND a verified combined quote in this one call. Use quote.total_gbp and its line totals instead of another pricing call or arithmetic. quote:null means price is unverified. Native automatically rechecks the camera/lens requirements already established by your searches against the selected physical basket. Stock and price can be verified while technical_qualification.verified is false; renter_quote:null then means do not offer its price as a suitable option. Continue the real specification review. When renter_quote is returned, read its commercial_guidance for the current exact-date option before composing your reply, then select its quote_key in a quote reply_part; the server renders its exact financial block. Do not rewrite its amounts in prose. Confirmed amendments use quote_booking_addition/replacement for their prices. Read-only, no booking changes. available:null is unknown. Check the exact requested unavailable items too; a price miss or an available alternative does not prove their stock.",
  inputSchema: z.object({
    account_slug:z.string(),thread_id:z.string().optional(),start_date:z.string(),end_date:z.string(),
    items:z.array(z.object({item_name:z.string(),quantity:z.number().int().min(1).max(20),product_id:z.number().int().positive().optional()})).min(1).max(8),
    booking_use:z.enum(["standalone","additional","replacement","separate"]).optional().describe("separate is a new independent hire while this thread has an existing booking. It keeps the current rental reserved and checks only the new basket; never extends or confirms either order."),
    replace_product_id:z.number().int().positive().optional(),replace_quantity:z.number().int().min(1).max(20).optional(),
    pickup_time:z.string().optional(),return_time:z.string().optional(),
  }),
  outputSchema:z.unknown(),
  execute:async(input)=>{
    const scope=currentRenterToolScope(),revision=scope?.queryRevision?.();
    const result=await convex().query(anyApi.renter_bot_tools.check_basket_availability,{...input,recommendation_requirements:structuredClone(scope?.recommendationRequirements??[])});
    const renter_quote=scope?nativeInquiryQuote(result,scope,revision):null;
    return {...result,renter_quote,renter_quote_reason:renter_quote?null:result.technical_qualification?.verified===false?"technical_requirements_unverified":"quote_unverified_or_stale"};
  },
});

// ── Tool 5: search_knowledge ──────────────────────────────────

export const searchKnowledgeTool = createTool({
  id: "search_knowledge",
  // Says what the KB does NOT hold, which is the expensive half.
  //
  // The old text ended "When unsure, query", and the agent obliged: measured
  // over a 40-turn sweep this was 52% of ALL tool calls, up to six in a single
  // turn. Every call is another step, and Mastra re-sends the whole ~8.5K base
  // prompt per step, so one flail costs ~50K tokens and six sequential round
  // trips to learn nothing.
  description:
    "Search Daniel's POLICY knowledge base: business rules, personal rules, delivery/location/edge-case protocols, verbatim templates, general FAQs. It does NOT contain per-item specs, prices, stock or kit contents — those come from get_listing_context and lookup_pricing, and searching here for them returns nothing. One query per topic: if it comes back empty, the answer is not in the KB and rephrasing will not find it.",
  inputSchema: z.object({
    query: z.string(),
    scope: z
      .enum(["all", "rule", "memory", "operational", "template", "faq"])
      .optional(),
    limit: z.number().int().positive().optional().default(5),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    const hits = await convex().query(anyApi.knowledge.search, input);
    // An empty array told the agent nothing, so it rephrased and tried again —
    // "Mavic 3 Classic specs 4k", then "Mavic 3", then "Mavic", then "specs",
    // then scope:rule "invented", then "intents conversation_stage". Say the
    // search failed and that retrying will not help.
    //
    // Shaped here rather than in convex/knowledge.ts because that query also
    // backs the draft route and the dashboard, which expect an array.
    if (Array.isArray(hits) && hits.length === 0)
      return {
        no_match: true,
        results: [],
        guidance:
          "Nothing in the knowledge base matches that. Do NOT search again for this topic with different wording — the KB holds policy and templates, not per-item specs, prices or stock. Answer from the FACTS you were already given, or tell the renter you'll confirm.",
      };
    return hits;
  },
});

// ── Tool 6: get_negotiation_stance ────────────────────────────

export const selectRentalRequestTool=createTool({
 id:"select_rental_request",
 description:"Select which hire this renter turn concerns. Call once BEFORE specification searches, availability, quotes or negotiation when the renter starts another independent hire, returns to the original booking, or resumes an earlier inquiry. new starts at the actual current renter message; primary returns to the original booking; resume requires an earlier Native origin_message_id; continue preserves the current inquiry. Changing dates, equipment, quantity or discussing cheaper alternatives within the same hire is continue, NEVER new. This read-only tool returns the correct request negotiation state. It never books, edits, cancels, verifies or grants a discount. Stock must still be checked for the exact requested basket. Do not create a new request merely to reset objections.",
 inputSchema:z.object({thread_id:z.string(),intent:z.enum(["continue","new","primary","resume"]),origin_message_id:z.string().optional()}),
 outputSchema:z.unknown(),
 execute:async(input)=>{
  const result=await convex().query(anyApi.renter_bot_tools.select_rental_request,input);
  recordRentalRequest(currentRenterToolScope(),result);
  return result;
 }
});

export const getNegotiationStanceTool = createTool({
  id: "get_negotiation_stance",
  description:
    "Compute Daniel's negotiation ladder state for this conversation. Returns objection count, whether a competitor was mentioned, stance (NONE | HOLD_FIRM | OFFER_ALTERNATIVES | SOFT_YIELD), and the suggested framing. Call WHEN the renter pushes back on price or mentions a cheaper option elsewhere.",
  inputSchema: z.object({
    thread_id: z.string(),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.get_negotiation_stance, input);
  },
});

// ── Tool 7: get_template ──────────────────────────────────────

export const getTemplateTool = createTool({
  id: "get_template",
  description:
    "Fetch a verbatim template's text by name. Use when you've identified a template via search_knowledge (e.g. 'DB Cinema Welcome Text', 'DB Cinema Arrival Reminder', 'DB Cinema Price Match'). Returns only an exact template identity for the Native thread account; a missing or ambiguous template returns found:false. Use current facts and negotiation strategy rather than substituting another template.",
  inputSchema: z.object({
    name: z.string(),
    thread_id: z.string().optional(),
    account_slug: z.string().optional(),
  }),
  outputSchema: z.unknown(),
  execute: async ({ name, thread_id, account_slug }) => {
    return await convex().query(anyApi.knowledge.getTemplate, {
      name,
      threadId: thread_id,
      accountSlug: account_slug,
    });
  },
});

// ── Tool 8: check_vacation ────────────────────────────────────

export const checkVacationTool = createTool({
  id: "check_vacation",
  description:
    "Check whether a requested date range overlaps an active owner-vacation period. Call BEFORE drafting ANY rental confirmation, quote, or availability-affirming reply. If in_vacation=true, the requested window is closed — propose `before` and/or `after` alternative windows in the draft instead of confirming. Returns {in_vacation, vacation?, before?, after?}.",
  inputSchema: z.object({
    start_date: z.string().describe("ISO YYYY-MM-DD"),
    end_date: z.string().describe("ISO YYYY-MM-DD"),
    item_id: z.string().optional().describe("Convex item id when checking a specific listing."),
    requested_qty: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    in_vacation: z.boolean(),
    vacation: z
      .object({ start: z.string(), end: z.string() })
      .optional(),
    before: z.object({ start: z.string(), end: z.string() }).optional(),
    after: z.object({ start: z.string(), end: z.string() }).optional(),
  }),
  execute: async ({ start_date, end_date, item_id, requested_qty }) => {
    const res = await convex().query(
      anyApi.vacation.getClosestAvailableDates,
      {
        requested_start: start_date,
        requested_end: end_date,
        ...(item_id ? { item_id } : {}),
        ...(requested_qty ? { requested_qty } : {}),
      },
    );
    return {
      in_vacation: !!res?.inVacation,
      vacation: res?.vacationPeriod,
      before: res?.before,
      after: res?.after,
    };
  },
});

// ── Tool 9: get_active_vacations ──────────────────────────────

export const getActiveVacationsTool = createTool({
  id: "get_active_vacations",
  description:
    "List all currently-active owner vacation periods (ordered by start date). Use to proactively mention upcoming breaks when relevant (e.g. renter asks about future availability). Returns an array of {start_date, end_date, reason?} objects.",
  inputSchema: z.object({}),
  outputSchema: z.array(
    z.object({
      start_date: z.string(),
      end_date: z.string(),
      reason: z.string().optional(),
    }),
  ),
  execute: async () => {
    const rows: Array<{
      start_date: string;
      end_date: string;
      reason?: string;
    }> = await convex().query(anyApi.vacation.getActiveVacations, {});
    return (rows ?? []).map((r) => ({
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
    }));
  },
});

// ── Aggregate export ──────────────────────────────────────────

// ── Tool 10: get_order_edit_state (READ-ONLY) ─────────────────
// Live view of the booking behind a thread — current items, price, and dates —
// so the draft can reference exactly what's on the order. READ-ONLY: order
// edits (add/remove item, price, dates) are OPERATOR-only via the dashboard,
// never reachable from a tool (this file's no-write contract holds).
export const getOrderEditStateTool = createTool({
  id: "get_order_edit_state",
  description:
    "Read the current Native Lab booking: actual items, price, total, dates, stage and change ledger. This read stays in the current server-bound thread and never calls the marketplace. Use its returned state after a retry; historical change summaries do not prove what is currently booked.",
  inputSchema: z.object({
    account_slug: z.string(),
    hygglo_order_id: z.string().describe("The Hygglo order id (same as the chat thread id)."),
  }),
  outputSchema: z.unknown(),
  execute: async (_input) => {
    const scope=currentRenterToolScope();
    if(!scope?.threadId.startsWith("__probe__"))return {ok:false,error:"Real booking state requires separate rollout authorization."};
    return await convex().query(anyApi.renter_bot_lab_order.get,{thread_id:scope.threadId});
  },
});

export const checkLocationTool = createTool({
  id: "check_location",
  description:
    "Compute the DELIVERY DISTANCE from THIS account hub to the renter postcode (postcodes.io + haversine) and whether it is within our delivery range. Call whenever the renter asks about delivery / drop-off / travel, or gives a postcode or area. Returns distance_km, within_delivery_range, and non_central (for the 10% distance discount).",
  inputSchema: z.object({
    renter_postcode: z.string().describe("The renter UK postcode (e.g. E1 6AN)."),
    account_slug: z.string().describe("The account_slug from get_renter_context."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().action(anyApi.renter_bot_tools.check_location, input);
  },
});

export const findOwnedAlternativesTool = createTool({
  id: "find_owned_alternatives",
  description:
    "Find owned alternatives that meet the requested role, sensor format, internal 4K, built-in ND and native mount before checking stock. Pass camera_requirements for every explicit hard camera requirement and lens_requirements for focus, wide-angle, macro, projection, coverage, focal length and aperture requirements. Do not call a lens suitable when lens_requirement_checked is false or required properties are unverified; clarify the exact lens/camera instead. Missing camera mode proof can return camera_review_needed and an owner_review_workflow. Those candidates are not qualified options; continue the owner check without asking the renter for permission. An unreviewed mode does not prove a camera is incapable or unavailable. Cinema/interchangeable-lens bodies must not be replaced with action cameras. Pass start_date, end_date, quantity and current thread_id when known: only options available for that request are returned. Without dates, ownership does NOT prove availability; check_availability before promising an option. For a current confirmed booking, pass booking_use=additional to retain the existing basket, or replacement plus its exact replace_product_id to remove the selected listing before checking the proposed basket. A replacement removes that listing’s kit contents; explain the difference. For a separate new hire use booking_use=separate: Native retains the current reservation and evaluates only the new candidate. Never use standalone to bypass an existing booking. Unknown context cannot prove availability. Returns account prices and tier tables. Look up the selected option's exact multi-day total before quoting it.",
  inputSchema: z.object({
    account_slug: z.string(),
    kind: z
      .string()
      .describe("REQUIRED — camera|lens|drone|gimbal|monitor|audio|lighting|grip|... — the SAME kind as the item that's unavailable"),
    lens_mount: z.string().optional().describe("Native mount required, e.g. E, RF, EF or L; applies to bodies and lenses. An adapter does not establish a native mount."),
    camera_requirements: z.object({
      role: z.enum(["action", "interchangeable_lens"]).optional(),
      sensor_format: z.enum(["full_frame", "super35", "aps_c", "small_sensor"]).optional(),
      internal_4k: z.boolean().optional(), built_in_nd: z.boolean().optional(),
      recording: z.object({
        resolution: z.enum([...RECORDING_REQUIREMENT_RESOLUTIONS,"4K"]).transform(canonicalRecordingResolution).describe("Use 4k/4K for generic 4K; uhd_4k or dci_4k only when that exact format is required. Do not infer a specific resolution format or frame rate from generic 4K."), min_fps: z.number().positive().optional().describe("Only set a minimum recording frame rate when the renter requires one."),
        capture_format: z.enum(["full_frame", "super35", "aps_c", "small_sensor"]).optional(),
        full_width: z.boolean().optional(), internal: z.boolean().optional(),
      }).optional(),
    }).optional().describe("Pass every hard camera requirement, including recording frame rate, capture format and full_width=true for an uncropped/full-sensor-width request. Physical sensor size does not establish recording capture area. Only source-reviewed modes qualify; read their conditions and explain mandatory settings/crops. Codec and bit-depth claims still require separate exact-model proof."),
    lens_requirements: z.object({excluded_projections:z.array(z.enum(["fisheye","anamorphic","rectilinear"])).optional(),focus_mode:z.enum(["autofocus","manual_focus"]).optional(),wide_angle:z.boolean().optional(),macro:z.boolean().optional(),projection:z.enum(["fisheye","anamorphic","rectilinear"]).optional(),coverage:z.literal("full_frame").optional(),focal_mm:z.number().positive().optional(),max_wide_focal_mm:z.number().positive().optional(),max_aperture_f:z.number().positive().optional(),max_aperture_t:z.number().positive().optional()}).optional().describe("REQUIRED for lens searches: desired alternative requirements only. Use {} for an unconstrained lens search. A fact or question about the current lens is not a requirement for the alternative. If results need_spec_review, ask to confirm the named owned items; zero verified matches does not establish inventory absence or dated unavailability. Focal length must be covered by the reviewed range. max_wide_focal_mm requires that focal length or wider. Unknown model properties cannot establish a match; f-stops and T-stops are separate."),
    exclude_name: z.string().optional(),
    lower_value_only: z.boolean().optional().describe("Use true for alternatives after failed verification. Compares recorded replacement values, never daily hire prices; unknown original value yields no lower-value suggestions. Keep the required category, mount, quantity and capability checks. Never promise approval."),
    item_name: z.string().optional().describe("Exact item being replaced, to rank suitable substitutes."),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    quantity: z.number().int().min(1).max(20).optional(),
    thread_id: z.string().optional(),
    booking_use: z.enum(["standalone","additional","replacement","separate"]).optional().describe("standalone for a new inquiry; additional retains the existing basket; replacement removes exact listing units, including their kit contents. Required to verify stock in a confirmed booking."),
    replace_product_id: z.number().int().positive().optional().describe("Exact current booking listing being replaced, from get_listing_context or current_booking_listings. Never guess a physical item's product ID."),
    replace_quantity: z.number().int().min(1).max(20).optional().describe("Number of units of that existing listing to replace. Defaults to suggested quantity; untouched units remain booked."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    const recording=input.camera_requirements?.recording;
    const result=await convex().query(anyApi.renter_bot_tools.find_owned_alternatives, recording
      ? {...input,camera_requirements:{...input.camera_requirements,recording:{...recording,resolution:canonicalRecordingResolution(recording.resolution)}}}
      : input);
    recordRecommendationRequirements(currentRenterToolScope(),result);
    return result;
  },
});


/**
 * SIMULATED booking edit — Renter Bot Lab only.
 *
 * Without this, "yes please, add the 100mm and the adapter" had no truthful
 * reply available: the bot could only ask the renter to confirm again (which
 * they just did), or claim it had added them and be blocked by the guard for
 * attributing an action to itself. Both were observed live.
 *
 * The Convex mutation refuses any thread id that is not a `__probe__` Lab
 * thread, so a real Hygglo booking cannot be reached through this tool. On a
 * real conversation it returns ok:false with an instruction to say the renter
 * should make the change on Hygglo.
 */
export const quoteBookingAdditionTool = createTool({
  id: "quote_booking_addition",
  description: "Read-only Renter Bot Lab quote: price the COMPLETE existing booking plus all proposed extra items in one check. For multiple extras use items with their exact product_id from lookup_pricing; separate single-item quotes cannot prove their combined cost, checking kit component stock and current duration tiers. Use before offering a combined new total, especially a smaller available alternative after an addition fails. Use addition_quote / additional_cost_gbp for the extra units and quote.total_gbp for the new complete total; a merged two-unit line is not the cost of one extra unit. This never adds or reserves anything. A successful quote is a proposal: say would bring the total to, never say added or booked. Real bookings require owner confirmation.",
  inputSchema: z.object({thread_id:z.string(),items:z.array(z.object({product_id:z.number().int().positive(),qty:z.number().int().min(1).max(20)})).min(1).max(8).optional(),item_name:z.string().optional().describe("Exact owned model or selected listing to add to the proposed basket."),product_id:z.number().int().positive().optional().describe("Exact listing ID from the Native price or listing result; preserves the selected kit and its component stock."),qty:z.number().int().min(1).max(20).default(1)}),
  outputSchema: z.unknown(),
  execute: async (input) => {
    if (!input.thread_id.startsWith("__probe__")) return {ok:false,error:"Combined booking proposals require an owner quote for real bookings."};
    if(input.items && (input.item_name || input.product_id!=null))return {ok:false,error:"Choose the items array or the single item fields, never both."};
    const scope = currentRenterToolScope();
    if (!scope) return { ok: false, error: "Missing verified booking context." };
    const client = convex();
    const order = await client.query(anyApi.renter_bot_lab_order.get, { thread_id: scope.threadId }) as { days?: number };
    let items = input.items;
    if (!items) {
      if (!input.item_name) return { ok: false, error: "Supply exact addition items or one exact item_name." };
      const price = await client.query(anyApi.renter_bot_tools.lookup_pricing, { item_name: input.item_name, product_id: input.product_id, account_slug: scope.accountSlug, days: order?.days, quantity: input.qty ?? 1 }) as { found?: boolean; product_id?: number };
      if (!price.found || !price.product_id) return { ok: false, error: "Selected offering price is unverified." };
      items = [{ product_id: price.product_id, qty: input.qty ?? 1 }];
    }
    try {
      const complete = await completeMountBasket(scope, items, order?.days,
        args => client.query(anyApi.renter_bot_tools.get_addition_mount_requirements, args),
        args => client.query(anyApi.renter_bot_tools.lookup_pricing, args),
        args => client.query(anyApi.renter_bot_lab_order.quoteAdditionBasket, args));
      return { ...(complete.proposal as Record<string, unknown>), required_accessory_names: complete.required.map(item => item.name),
        required_accessory_quotes: complete.accessoryPrices, renter_supplied_adapters: complete.renterSupplied, setup_quote_guidance: "This read-only quote includes required owner-supplied adapters. Renter-supplied matching adapters are their responsibility and are not charged. Quote the complete extra cost or every component; do not offer a lens-only price as the usable setup cost." };
    } catch { return { ok: false, error: "The complete compatible setup quote is unverified. No booking changes were made." }; }
  },
});

export const quoteBookingReplacementTool=createTool({
 id:"quote_booking_replacement",
 description:"Read-only Lab quote for replacing exact current listing units with selected offerings. Returns the complete retained-plus-replacement basket, joint component stock, dates, total and price difference. Use before quoting a replacement booking total; an alternative item quote alone cannot prove that total. Supply exact listing IDs from Native tools. No booking is changed. Collected rentals and real bookings require owner review.",
 inputSchema:z.object({thread_id:z.string(),items:z.array(z.object({product_id:z.number().int().positive(),qty:z.number().int().min(1).max(20)})).min(1).max(8),replace_product_id:z.number().int().positive(),replace_quantity:z.number().int().min(1).max(20)}),
 outputSchema:z.unknown(),
 execute:async(input)=>{
   const scope=currentRenterToolScope();
   if(!scope?.threadId.startsWith("__probe__"))return {ok:false,error:"Real replacement quotes require owner review and separate rollout consent."};
   const client=convex();
   const order=await client.query(anyApi.renter_bot_lab_order.get,{thread_id:scope.threadId}) as {days?:number};
   try {
     const complete=await completeMountBasket(scope,input.items,order?.days,
       args=>client.query(anyApi.renter_bot_tools.get_addition_mount_requirements,args),
       args=>client.query(anyApi.renter_bot_tools.lookup_pricing,args),
       args=>client.query(anyApi.renter_bot_lab_order.quoteReplacementBasket,{...args,replace_product_id:input.replace_product_id,replace_quantity:input.replace_quantity}));
     return {...(complete.proposal as Record<string,unknown>),required_accessory_names:complete.required.map(i=>i.name),required_accessory_quotes:complete.accessoryPrices,renter_supplied_adapters:complete.renterSupplied};
   }catch{return {ok:false,error:"The complete replacement setup quote is unverified. No booking changes were made."};}
 },
});

export const quoteBookingDatesTool=createTool({
 id:"quote_booking_dates",
 description:"Read-only Native Lab quote for changing the dates of the COMPLETE current booking. Check the full pickup/return span, duration tiers and every physical kit component before offering the new full total. This never changes or reserves anything. Quote the exact dates and quote.total_gbp (not merely an extra day's base rate); price_delta_gbp is the difference from the current total. Say would change, never changed. After the renter agrees to that unchanged offer, use modify_booking set_dates without asking them to agree again.",
 inputSchema:z.object({thread_id:z.string(),start_date:z.string(),end_date:z.string()}),outputSchema:z.unknown(),
 execute:async(input)=>{if(!input.thread_id.startsWith("__probe__"))return {ok:false,error:"Real booking changes require separate written rollout consent."};
  if(!currentRenterToolScope())return {ok:false,error:"Missing verified booking context."};
  return convex().query(anyApi.renter_bot_lab_order.quoteDateChange,input);},
});

export const modifyBookingTool = createTool({
  id: "modify_booking",
  description:
    "SIMULATION (Renter Bot Lab only): atomically add one item or a complete group of items, remove an item, or change the dates on the test booking, and get back the updated line items, day count and total. Call this when the renter ASKS you to add/remove gear or move dates and has already said yes — do not ask them to confirm something they just asked for. Use replace_items for an agreed swap, with every selected listing and adapter plus the exact current replace_product_id and replace_quantity from quote_booking_replacement. Never split a swap into remove_item and add_item calls: the transaction succeeds together or leaves the existing booking unchanged. Use add_items with every exact product_id and qty for a quoted setup, including its required owner-supplied adapters. The complete group either succeeds together or nothing is changed. Never make separate add_item calls for parts of the same agreed setup. A missing required adapter returns complete_setup_required: quote the complete setup and ask for its agreement instead of adding an incomplete setup. For date changes, use quote_booking_dates to offer the complete new dates and total before an increase. A clear named/date request at the exact price, or acceptance of that unchanged sent quote, authorizes the edit. Returns ok:false with a reason if the item can't be identified or this is a real conversation; if ok is false you must NOT claim any change was made. If action_performed is false or already_applied is true, no new edit occurred: describe the CURRENT returned order as already set/containing the requested items, never say I moved/added/removed them. previous_change_summary is history, not a new change or proof that those items are still present.",
  inputSchema: z.object({
    thread_id: z.string().describe("The conversation/thread id."),
    action: z
      .enum(["add_item", "add_items", "replace_items", "remove_item", "set_dates"])
      .describe("What to do to the booking."),
    items: z.array(z.object({product_id:z.number().int().positive(),qty:z.number().int().min(1).max(20)})).min(1).max(8).optional().describe("For add_items: every exact listing and quantity accepted together, including required adapters."),
    replace_product_id:z.number().int().positive().optional().describe("For replace_items: exact current listing selected in the agreed replacement quote."),
    replace_quantity:z.number().int().min(1).max(20).optional().describe("For replace_items: exact agreed current units removed."),
    item_name: z.string().optional().describe("Exact item name for add_item/remove_item."),
    product_id: z.number().int().positive().optional().describe("Exact Native listing ID when selecting a specific priced kit or booked offering. Preserves its components and chooses the correct line."),
    qty: z.number().optional().describe("Units to add or remove (defaults to 1). To remove all units of a model, read get_lab_order and pass that exact booked quantity. Never guess a quantity or remove a different model."),
    start_date: z.string().optional().describe("YYYY-MM-DD, for set_dates."),
    end_date: z.string().optional().describe("YYYY-MM-DD, for set_dates. Same as start for a one-day rental."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    if (!input.thread_id.startsWith("__probe__")) {
      return {
        ok: false,
        error:
          "You cannot modify a real booking. Tell the renter you'll note it and that they can add it on the listing page, or that you'll confirm it with them.",
      };
    }
    const client=convex();
    if(input.action==="replace_items") {
      if(!input.items||input.replace_product_id==null||input.replace_quantity==null||input.item_name||input.product_id!=null||input.qty!=null||input.start_date||input.end_date)return {ok:false,error:"Use the complete accepted items array and exact current replacement listing/quantity."};
      return await client.mutation(anyApi.renter_bot_lab_order.applyReplacementBasket,{thread_id:input.thread_id,request_message_id:"",items:input.items,replace_product_id:input.replace_product_id,replace_quantity:input.replace_quantity});
    }
    if(input.replace_product_id!=null||input.replace_quantity!=null)return {ok:false,error:"Replacement fields require replace_items."};
    if (input.action==="add_item" || input.action==="add_items") {
      if (input.action==="add_items" && (!input.items || input.item_name || input.product_id!=null || input.qty!=null)) return {ok:false,error:"Use only the items array for add_items."};
      if (input.action==="add_item" && input.items) return {ok:false,error:"Use add_items for a complete group."};
      let items=input.items;
      if (!items) {
        let productId=input.product_id;
        if (productId==null && input.item_name) {
          const scope=currentRenterToolScope();
          if(!scope)return {ok:false,error:"Missing verified booking context."};
          const order=await client.query(anyApi.renter_bot_lab_order.get,{thread_id:scope.threadId}) as {days?:number};
          const price=await client.query(anyApi.renter_bot_tools.lookup_pricing,{item_name:input.item_name,account_slug:scope.accountSlug,days:order?.days,quantity:input.qty??1}) as {found?:boolean;product_id?:number};
          if(price.found)productId=price.product_id;
        }
        if(productId==null)return {ok:false,error:"Use an exact verified listing before adding it. No changes were made."};
        items=[{product_id:productId,qty:input.qty??1}];
      }
      return await client.mutation(anyApi.renter_bot_lab_order.applyAdditionBasket,{thread_id:input.thread_id,request_message_id:"",items});
    }
    if(input.items)return {ok:false,error:"Items arrays apply only to add_items."};
    const {items:_unused,replace_product_id:_replace,replace_quantity:_replaceQty,...legacy}=input;
    return await client.mutation(anyApi.renter_bot_lab_order.applyChange,legacy);
  },
});

export const restoreReferralBasketTool=createTool({
  id:"restore_referral_basket",
  description:"Restore selected original friend-referral gear into the renter's empty Lab inquiry. get_listing_context supplies the verified code and exact original listing IDs. Only use for the CURRENT renter's direct instruction to restore/add/use that basket, or their unambiguous acceptance of the exact Native referral_context.pending_offer. Use the pending offer's exact terms for an acceptance. A code, an information question or a quote is not consent. Respect their current dates, quantities and exclusions; never inherit the source's approval/payment/verification. Native rechecks original equipment identity, joint stock and prices atomically and returns renter_quote for the applied basket. Select its quote_key through a quote reply_part to show the checked amounts; no second stock or pricing call is needed. Previous quote receipts are stale after restoration. A missing renter_quote needs real review before quoting a price. Does not create or confirm a booking. For read-only quotes use check_basket_availability instead. Real Hygglo writes are unavailable.",
  inputSchema:z.object({thread_id:z.string(),code:z.string().uuid(),start_date:z.string(),end_date:z.string(),items:z.array(z.object({product_id:z.number().int().positive(),qty:z.number().int().min(1).max(20)})).min(1).max(8)}),
  outputSchema:z.unknown(),
  execute:async(input)=>{
    const scope=currentRenterToolScope();
    if(!scope?.requestMessageId)throw new Error("Restoration needs a scoped current renter request");
    const result=await convex().mutation(anyApi.renter_bot_lab_order.redeemReferral,{...input,recommendation_requirements:structuredClone(scope.recommendationRequirements??[])});
    if(result.ok===true && result.action_performed===true && result.source==="native_lab_amendment")
      for(const requirement of result.verified_inquiry_quote?.recommendation_requirements??[])recordRecommendationRequirements(scope,{
        kind:requirement.kind,[requirement.kind==="camera"?"camera_requirements":"lens_requirements"]:requirement.requirements,
        requested_quantity:requirement.quantity,required_native_mount:requirement.native_mount,target_item_id:requirement.target_item_id});
    const renter_quote=result.ok===true&&result.action_performed===true?nativeInquiryQuote(result.verified_inquiry_quote,scope):null;
    const referral_context=result.ok===true && (result.action_performed===true || result.already_applied===true)?
      {ok:true,code:input.code,already_linked:true,guidance:"The referral is linked to this destination inquiry. Use the applied basket and current stage; do not offer restoration again. No booking was created or confirmed."}:undefined;
    return {...result,message:result.ok===true&&result.action_performed===true?"Selected referral equipment was restored to this new inquiry. No booking was created or confirmed. Use renter_quote through a quote reply_part for the checked dates and prices.":result.message,
      referral_context,renter_quote,verified_inquiry_quote:result.verified_inquiry_quote?{...result.verified_inquiry_quote,renter_quote}:null};
  },
});

export const RENTER_BOT_TOOLS = {
  restore_referral_basket:restoreReferralBasketTool,
  find_owned_alternatives: findOwnedAlternativesTool,
  quote_booking_replacement:quoteBookingReplacementTool,
  check_location: checkLocationTool,
  get_order_edit_state: getOrderEditStateTool,
  modify_booking: modifyBookingTool,
  quote_booking_addition: quoteBookingAdditionTool,
  quote_booking_dates: quoteBookingDatesTool,
  get_renter_context: getRenterContextTool,
  get_listing_context: getListingContextTool,
  lookup_pricing: lookupPricingTool,
  check_availability: checkAvailabilityTool,
  check_basket_availability: checkBasketAvailabilityTool,
  search_knowledge: searchKnowledgeTool,
  get_negotiation_stance: getNegotiationStanceTool,
  select_rental_request:selectRentalRequestTool,
  get_template: getTemplateTool,
  check_vacation: checkVacationTool,
  get_active_vacations: getActiveVacationsTool,
} as const;
