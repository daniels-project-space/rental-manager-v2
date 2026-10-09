import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import { validOwnerSetupInvite } from "./lib/owner_setup";
import { OWNER_RESET_SECONDS, ownerRecoveryConfig, ownerResetTokenHash, sendOwnerRecovery } from "./lib/owner_recovery";

export const authComponent = createClient<DataModel>(components.betterAuth);

export function createAuth(ctx: GenericCtx<DataModel>) {
  // Better Auth's email runner catches callback failures. Preserve per-request
  // failure state so the after hook can return an honest service error instead.
  const failedRecoveryRequests = new WeakSet<Request>();
  return betterAuth({
    baseURL: process.env.SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true, minPasswordLength: 12,
      resetPasswordTokenExpiresIn: OWNER_RESET_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }, request) => {
        try {
          if (!("runMutation" in ctx)) throw Error("Recovery needs a writable context");
          const reserved = await ctx.runMutation(internal.owner_access.reserveRecoveryMail, { auth_user_id: user.id, email: user.email, token_hash: await ownerResetTokenHash(token) });
          if (!reserved) return;
          await sendOwnerRecovery(user.email, token, url);
        }
        catch {
          if (request) failedRecoveryRequests.add(request);
          throw new APIError("SERVICE_UNAVAILABLE", { message: "Owner recovery is temporarily unavailable. Please try again later." });
        }
      },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30,
      customRules: { "/request-password-reset": { window: 60, max: 3 }, "/reset-password": { window: 60, max: 5 }, "/sign-in/email": { window: 60, max: 10 } } },
    user: { changeEmail: { enabled: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    database: authComponent.adapter(ctx),
    hooks: {
      before: createAuthMiddleware(async (request) => {
        if (request.path === "/reset-password") {
          const password = request.body?.newPassword;
          if (typeof password !== "string" || password.length < 12 || password.length > 128)
            throw new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD_LENGTH", message: "Use between 12 and 128 characters." });
          let digest: string;
          try { digest = await ownerResetTokenHash(request.body?.token ?? request.query?.token ?? ""); }
          catch { throw new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "This reset link is invalid or has expired." }); }
          if (!("runMutation" in ctx)) throw new APIError("SERVICE_UNAVAILABLE", { message: "Owner recovery is temporarily unavailable." });
          if (!await ctx.runMutation(internal.owner_access.claimRecoveryToken, { token_hash: digest }))
            throw new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "This reset link is invalid or has expired." });
        }
        if (request.path === "/request-password-reset") {
          let origin: string;
          try { origin = ownerRecoveryConfig().origin; }
          catch { throw new APIError("SERVICE_UNAVAILABLE", { message: "Owner recovery is temporarily unavailable. Please try again later." }); }
          if (!request.request) throw new APIError("SERVICE_UNAVAILABLE", { message: "Use the private login page to recover your account." });
          if (request.body?.redirectTo !== undefined) {
            let destination: URL;
            try { destination = new URL(request.body.redirectTo, origin); }
            catch { throw new APIError("FORBIDDEN", { message: "Invalid recovery destination." }); }
            if (destination.origin !== origin || destination.pathname !== "/login" || destination.hash)
              throw new APIError("FORBIDDEN", { message: "Invalid recovery destination." });
          }
        }
        if (request.path !== "/sign-up/email") return;
        const owner = await ctx.runQuery(internal.owner_access.get, {});
        const allowed = !owner && await validOwnerSetupInvite(
          request.headers?.get("x-owner-setup-invite") ?? null,
          process.env.OWNER_SETUP_TOKEN_HASH,
        );
        if (!allowed) throw new APIError("FORBIDDEN", { message: "A valid private owner setup invitation is required." });
      }),
      after: createAuthMiddleware(async (request) => {
        if (request.path === "/request-password-reset" && request.request && failedRecoveryRequests.has(request.request))
          throw new APIError("SERVICE_UNAVAILABLE", { message: "Owner recovery is temporarily unavailable. Please try again later." });
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
