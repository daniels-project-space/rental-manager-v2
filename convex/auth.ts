import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import { validOwnerSetupInvite } from "./lib/owner_setup";

export const authComponent = createClient<DataModel>(components.betterAuth);

export function createAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth({
    baseURL: process.env.SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    user: { changeEmail: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    database: authComponent.adapter(ctx),
    hooks: {
      before: createAuthMiddleware(async (request) => {
        if (request.path !== "/sign-up/email") return;
        const owner = await ctx.runQuery(internal.owner_access.get, {});
        const allowed = !owner && await validOwnerSetupInvite(
          request.headers?.get("x-owner-setup-invite") ?? null,
          process.env.OWNER_SETUP_TOKEN_HASH,
        );
        if (!allowed) throw new APIError("FORBIDDEN", { message: "A valid private owner setup invitation is required." });
      }),
      after: createAuthMiddleware(async (request) => {
        if (request.path !== "/sign-up/email" || !request.context.newSession) return;
        if (!("runMutation" in ctx)) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Owner setup requires a writable authentication context." });
        const user = request.context.newSession.user;
        await ctx.runMutation(internal.owner_access.register, { auth_user_id: user.id, email: user.email });
      }),
    },
    plugins: [convex({ authConfig })],
  });
}

/** Login UI state only. Operational data still needs its own owner guard. */
export const state = query({
  args: {},
  handler: async (ctx): Promise<{ authenticated: boolean; isOwner: boolean; setupAvailable: boolean }> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    const owner = await ctx.db.query("owner_access").first();
    return {
      authenticated: Boolean(user),
      isOwner: Boolean(user && owner?.auth_user_id === user._id),
      setupAvailable: !owner && Boolean(process.env.OWNER_SETUP_TOKEN_HASH),
    };
  },
});
