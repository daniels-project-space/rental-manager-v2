import { z } from "zod";

/** Validated Native task context for Mastra. Workflow is distinct from
 * current reviewed specifications and never establishes a booking quote. */
export const renterOwnerCheckContextSchema = z.object({
  kind:z.enum(["lens_recommendation","camera_recommendation","listing_mapping","kit_recommendation"]),
  product_id:z.number().nullable(),candidate_product_ids:z.array(z.number()).nullable(),
  task_id:z.string(),status:z.enum(["pending","handled_by_owner"]),requirements:z.unknown(),lens_mount:z.string().nullable(),
  start_date:z.string().nullable(),end_date:z.string().nullable(),quantity:z.number(),candidate_names:z.array(z.string()),
  context_changed:z.boolean(),source_message_id:z.string(),last_requested_message_id:z.string(),
  specification_result_verified:z.boolean(),customer_input_required:z.literal(false),
  current_specification_reviews:z.array(z.object({name:z.string(),status:z.enum(["match","mismatch","unknown"]),unknown:z.array(z.string()),mismatched:z.array(z.string())})).nullable(),
  specification_guidance:z.string().nullable(),
});

/** The exact output contract registered on the Mastra renter-context tool. */
export const renterContextOutputSchema = z.object({
    thread_id: z.string(),
    account_slug: z.string(),
    hygglo_order_id: z.string(),
    renter: z.unknown().nullable(),
    renter_history:z.object({platform_completed_rentals:z.number().nullable(),recorded_rentals_with_us:z.number().nullable(),last_rental_with_us_at:z.number().nullable()}),
    conversation_stage: z.string(),
    rental_stage: z.unknown(),
    active_request_stage:z.unknown().optional(),
    last_message_id: z.string().nullable(),
    owner_checks: z.array(renterOwnerCheckContextSchema),
    rental_request:z.unknown(),
    rental_requests:z.array(z.unknown()),
    renter_camera_identities:z.unknown(),
    last_messages: z.array(
      z.object({
        sender: z.string(),
        sender_name: z.string(),
        body: z.string(),
        at: z.number(),
      }),
    ),
  });
