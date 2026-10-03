import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { ownerEnforcementRequired } from "../../convex/lib/owner_authorization";
import { getToken } from "./auth-server";
import { createConvexServiceClient } from "./convex-service";
import { withConvexClientFactory, type ConvexClientFactory } from "./convex-request-context";

const RENTAL_CONVEX_URL = "https://hearty-oyster-600.convex.cloud";
type Route = (request: Request, client: ConvexHttpClient) => Promise<Response>;

class OwnerRequestError extends Error {
  constructor(readonly status: 401 | 403, message: string) { super(message); }
}

/** Verify owner membership once; never substitute a service credential for a user. */
export async function ownerClientFactory(): Promise<ConvexClientFactory> {
  const required = ownerEnforcementRequired(process.env.OWNER_AUTH_REQUIRED);
  const url = process.env.CONVEX_URL ?? RENTAL_CONVEX_URL;
  if (url !== RENTAL_CONVEX_URL) throw new Error("Unexpected rental Convex deployment");
  const token = await getToken();
  const factory = () => {
    const client = new ConvexHttpClient(url);
    if (token) client.setAuth(token);
    return client;
  };
  if (!token) {
    if (required) throw new OwnerRequestError(401, "owner_login_required");
    // Transitional compatibility until owner onboarding and all callers are ready.
    return factory;
  }
  const state = await factory().query(api.auth.state, {});
  if (!state.authenticated) throw new OwnerRequestError(401, "owner_session_expired");
  if (!state.isOwner) throw new OwnerRequestError(403, "owner_access_required");
  return factory;
}

export function withOwnerRoute(handler: Route) {
  return async (request: Request): Promise<Response> => {
    let factory: ConvexClientFactory;
    try { factory = await ownerClientFactory(); }
    catch (error) {
      return NextResponse.json({ ok: false, error: error instanceof OwnerRequestError ? error.message : "authentication_unavailable" },
        { status: error instanceof OwnerRequestError ? error.status : 503 });
    }
    return withConvexClientFactory(factory, () => handler(request, factory()));
  };
}

/** Only for endpoints with their own private server-secret check or minimal public health/key output. */
export function withServiceRoute(handler: Route) {
  return async (request: Request): Promise<Response> => {
    let client: ConvexHttpClient;
    try {
      client = createConvexServiceClient();
    } catch {
      return NextResponse.json({ ok: false, error: "service_unavailable" }, { status: 503 });
    }
    return withConvexClientFactory(createConvexServiceClient, () => handler(request, client));
  };
}
