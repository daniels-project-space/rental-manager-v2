import { task } from "@trigger.dev/sdk/v3";
import { internal } from "../../convex/_generated/api";
import { createConvexServiceClient } from "../lib/convex-service";

/** On-demand, read-only production check; never accesses Hygglo. */
export const rentalServiceHealth = task({
  id: "rental-service-health",
  maxDuration: 30,
  run: async () => {
    const convex = createConvexServiceClient();
    const result = await convex.query(internal.owner_auth_probe.serviceIdentity, {});
    return { backend: convex.url, authenticated_service: result.authenticated_service, read_only: true };
  },
});
