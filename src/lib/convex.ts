import { ConvexReactClient } from "convex/react";

// Single source of truth: poller writes to hearty-oyster-600 (see src/trigger/poll-hygglo.ts:20). Reading from exciting-lion-29 caused split-brain (stale 200-row snapshot, missing 1481 v1 imports).
export const convex = new ConvexReactClient(
  "https://hearty-oyster-600.convex.cloud"
);
