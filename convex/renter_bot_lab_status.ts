"use node";

import { v } from "convex/values";
import { action } from "./owner_functions";

/** Read-only check for the hosted Lab's isolated draft connection. */
export const checkDraftAuth = action({
  args: { expectedMarker: v.string() },
  handler: async (_ctx, { expectedMarker }) => ({
    ready: Boolean(process.env.RENTER_BOT_API_SECRET?.trim()) &&
      process.env.RENTER_BOT_LAB_AUTH_CONFIG_VERSION === expectedMarker,
  }),
});
