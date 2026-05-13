import { ConvexReactClient } from "convex/react";

// NEXT_PUBLIC_CONVEX_URL must point to the prod deployment (exciting-lion-29)
export const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL as string
);
