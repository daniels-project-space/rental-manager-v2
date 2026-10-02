/** Retries belong to individual model calls within a Mastra run. Never wrap
 * an entire agent run: its completed tools may have changed a booking. */
export const RENTER_MODEL_RETRIES = 2;
