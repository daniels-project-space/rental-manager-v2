import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType, UserIdentityAttributes } from "convex/server";
import { OWNER_SERVICE_ISSUER, OWNER_SERVICE_SUBJECT } from "../../convex/lib/owner_authorization";

const RENTAL_CONVEX_URL = "https://hearty-oyster-600.convex.cloud";

// Admin transport can call private functions; the ordinary HTTP client types cannot.
export type ConvexServiceClient = ConvexHttpClient & {
  query<Query extends FunctionReference<"query", "internal">>(
    reference: Query, args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>;
  mutation<Mutation extends FunctionReference<"mutation", "internal">>(
    reference: Mutation, args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;
};

/** Private worker transport. Never import this into a browser component. */
export function createConvexServiceClient(url = process.env.CONVEX_URL ?? RENTAL_CONVEX_URL): ConvexServiceClient {
  if (typeof window !== "undefined") throw new Error("Convex service credentials are server-only");
  // A credential from another deployment must never redirect the rental poller.
  if (url !== RENTAL_CONVEX_URL) throw new Error("Unexpected rental Convex deployment");
  const key = process.env.CONVEX_DEPLOY_KEY;
  if (!key?.trim()) throw new Error("Missing private CONVEX_DEPLOY_KEY for rental worker");
  const client = new ConvexHttpClient(url);
  // Convex implements this admin transport, but excludes it from its public d.ts.
  const admin = client as ConvexHttpClient & {
    setAdminAuth(token: string, identity: UserIdentityAttributes): void;
  };
  admin.setAdminAuth(key, { issuer: OWNER_SERVICE_ISSUER, subject: OWNER_SERVICE_SUBJECT });
  return client as ConvexServiceClient;
}
