import { query as rawQuery, mutation as rawMutation, action as rawAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { authorizeOwner, ownerEnforcementRequired } from "./lib/owner_authorization";

export * from "./_generated/server";

export async function requireOwner(ctx: GenericCtx<DataModel>) {
  if (!ownerEnforcementRequired(process.env.OWNER_AUTH_REQUIRED)) return;
  await authorizeOwner(
    await ctx.auth.getUserIdentity(),
    process.env.CONVEX_SITE_URL,
    () => "db" in ctx ? ctx.db.query("owner_access").first() : ctx.runQuery(internal.owner_access.get, {}),
    () => authComponent.safeGetAuthUser(ctx),
  );
}

// Preserve each SDK builder's complete type signature and validator behavior.
// Internal builders remain unchanged; only publicly callable registrations wrap.
function protect<Builder>(builder: Builder): Builder {
  return ((definition: any) => {
    const original = typeof definition === "function" ? definition : definition.handler;
    const handler = async (ctx: GenericCtx<DataModel>, args: unknown) => {
      await requireOwner(ctx);
      return original(ctx, args);
    };
    return (builder as any)(typeof definition === "function" ? handler : { ...definition, handler });
  }) as Builder;
}

export const query = protect(rawQuery);
export const mutation = protect(rawMutation);
export const action = protect(rawAction);
